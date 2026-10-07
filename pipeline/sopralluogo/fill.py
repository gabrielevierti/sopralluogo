"""Content-aware fill of what the camera could not see.

When you orbit away from the camera, objects in front (a pole, a kiosk, a tree)
leave holes in what is behind them. Here we build a second, hidden layer:

* depth: the far surface is extended behind each occluder (inpainting in inverse
  depth), then snapped back onto the ground and the walls where it belongs;
* colour: the background plate is inpainted with OpenCV's FSR (frequency-selective
  reconstruction), which continues edges and texture far better than diffusion.

The filled layer is rendered *behind* the real surface, so from the camera's
point of view nothing changes; it only shows when you look around an object.
It is invented content and the viewer labels it as such (layer can be turned off).
"""
from __future__ import annotations

import cv2
import numpy as np

from .geometry import CameraModel
from .log import log


def occluder_mask(z: np.ndarray, labels: np.ndarray, window: int = 41, ratio: float = 0.82) -> np.ndarray:
    """Free-form surfaces clearly nearer than what surrounds them (they hide something)."""
    zf = np.nan_to_num(z, nan=0.0).astype(np.float32)
    far = cv2.dilate(zf, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (window, window)))
    occ = np.isfinite(z) & (labels == 0) & (z < ratio * far)
    occ = cv2.morphologyEx(occ.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return cv2.dilate(occ, np.ones((7, 7), np.uint8)).astype(bool)


def inpaint_color(bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    valid = np.where(mask, 0, 255).astype(np.uint8)
    if hasattr(cv2, "xphoto"):
        out = np.zeros_like(bgr)
        # FSR is slow on huge masks: work at half resolution when the hole is big
        if mask.mean() > 0.06:
            small = cv2.resize(bgr, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
            vm = cv2.resize(valid, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
            so = np.zeros_like(small)
            cv2.xphoto.inpaint(small, vm, so, cv2.xphoto.INPAINT_FSR_FAST)
            out = cv2.resize(so, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
        else:
            cv2.xphoto.inpaint(bgr, valid, out, cv2.xphoto.INPAINT_FSR_FAST)
        method = "FSR (opencv-contrib)"
    else:
        out = cv2.inpaint(bgr, mask.astype(np.uint8), 7, cv2.INPAINT_TELEA)
        method = "Telea"
    res = bgr.copy()
    res[mask] = out[mask]
    return res, method


def fill_behind(bgr: np.ndarray, z: np.ndarray, labels: np.ndarray, planes: list, cam: CameraModel,
                max_depth: float):
    """Returns (filled colour, filled depth, mask of filled pixels, report).

    Only surfaces whose shape is known are extended: the floor continues under and
    behind free-standing objects (trees, planters, poles, kiosks), and each wall
    continues behind what stands in front of it. Free-form shapes are never invented,
    so no fake "curtains" appear between near and far objects.
    """
    h, w = z.shape
    vs, us = np.mgrid[0:h, 0:w]
    zp, okp = cam.ground_depth(us, vs)
    finite = np.isfinite(z)
    obj = (labels == 0) | ~finite  # free-standing objects or missing surface

    # ---- floor behind objects (never behind walls: no floor inside buildings)
    floor = okp & (zp < max_depth) & obj & (~finite | (z < 0.97 * zp))
    # the floor must be connected to visible floor: drop regions entirely enclosed by walls
    visible_floor = labels == 1
    reach = cv2.dilate(visible_floor.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=25) > 0
    n, comp, _, _ = cv2.connectedComponentsWithStats(floor.astype(np.uint8), connectivity=8)
    keep_ids = np.unique(comp[floor & reach])
    floor &= np.isin(comp, keep_ids[keep_ids > 0])

    zf = np.full_like(z, np.nan)
    zf[floor] = zp[floor]

    # ---- walls behind objects
    T = cam.world_from_cam()
    rays_w = cam.rays(us, vs) @ T[:3, :3].T
    C = T[:3, 3]
    wall_mask = np.zeros_like(floor)
    for k, (n_, off) in enumerate(planes):
        region = (labels == 2 + k).astype(np.uint8)
        if not region.any():
            continue
        region = cv2.morphologyEx(region, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61))) > 0
        denom = rays_w[..., [0, 2]] @ n_
        with np.errstate(divide="ignore", invalid="ignore"):
            zpl = (off - C[[0, 2]] @ n_) / denom
        m = region & obj & np.isfinite(zpl) & (zpl > 0) & (zpl < max_depth) & (~finite | (z < 0.97 * zpl))
        # the wall stands on the floor: never extend it below the ground line
        m &= ~(okp & (zp < zpl))
        m &= ~floor | (zpl < zf)
        zf[m] = zpl[m]
        wall_mask |= m
        floor &= ~m

    mask = floor | wall_mask
    if not mask.any():
        return bgr, zf, mask, {"filled_ratio": 0.0}
    color, method = inpaint_color(bgr, mask)
    log(f"Riempimento: {mask.mean() * 100:.1f}% dell'immagine (pavimento {floor.mean() * 100:.1f}%, "
        f"muri {wall_mask.mean() * 100:.1f}%) ricostruito dietro gli oggetti ({method})")
    fill_labels = np.where(floor, 1, np.where(wall_mask, labels.max() + 1, 0)).astype(np.int32)
    return color, zf, mask, {"filled_ratio": float(mask.mean()), "floor_ratio": float(floor.mean()),
                             "wall_ratio": float(wall_mask.mean()), "color_method": method,
                             "_labels": fill_labels}
