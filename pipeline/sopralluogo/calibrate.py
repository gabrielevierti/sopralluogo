"""Self-calibration of a fixed camera.

1. People as a ruler: every standing person gives a (feet, head) pixel pair.
   Assuming an average body height H, the camera pitch, roll, height above
   the ground (and optionally the focal length) are those that make all the
   people "stand up" on one common ground plane. This is classic single-view
   metrology (Criminisi et al.; Lv, Zhao, Nevatia 2006).
2. The neural depth map is only correct up to an affine transform of inverse
   depth. The ground plane found in step 1 provides metric depth at the
   pixels where people walked, which fixes that transform.
"""
from __future__ import annotations

import cv2
import numpy as np
from scipy.optimize import least_squares

from .geometry import CameraModel, intrinsics_from_hfov
from .log import log


def person_samples(tracks, width: int, height: int, margin: int = 3):
    """(foot_u, foot_v, head_u, head_v, track_id) for detections that look like full standing people."""
    rows = []
    for t in tracks:
        if t.cls != "persona":
            continue
        for _, d in t.obs:
            x1, y1, x2, y2 = d["bbox"]
            bw, bh = x2 - x1, y2 - y1
            if d["conf"] < 0.45 or bh < 24:
                continue
            if x1 < margin or y1 < margin or x2 > width - margin or y2 > height - margin:
                continue
            if not 1.7 <= bh / max(bw, 1) <= 5.0:  # standing, not sitting/occluded
                continue
            u = (x1 + x2) / 2
            rows.append((u, y2, u, y1, t.id))
    return np.array(rows, dtype=np.float64).reshape(-1, 5)


def vertical_segments(bgr: np.ndarray, min_len: float = 35.0) -> np.ndarray:
    """Long, near-vertical edges of the static scene (poles, walls, door frames).

    In the real world they are all parallel to gravity, so in the image they meet
    in one vanishing point. That point pins down tilt and focal length far better
    than people alone.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    segs = cv2.createLineSegmentDetector().detect(gray)[0]
    if segs is None:
        return np.zeros((0, 4))
    segs = segs.reshape(-1, 4).astype(np.float64)
    d = segs[:, 2:] - segs[:, :2]
    length = np.hypot(d[:, 0], d[:, 1])
    ang = np.degrees(np.arctan2(np.abs(d[:, 0]), np.abs(d[:, 1])))
    segs = segs[(length > min_len) & (ang < 20)]
    if len(segs) < 6:
        return np.zeros((0, 4))
    # RANSAC on the vanishing point (homogeneous, so a point at infinity is fine)
    p1 = np.c_[segs[:, :2], np.ones(len(segs))]
    p2 = np.c_[segs[:, 2:], np.ones(len(segs))]
    lines = np.cross(p1, p2)
    rng = np.random.default_rng(0)
    best = None
    for _ in range(400):
        i, j = rng.choice(len(segs), 2, replace=False)
        vp = np.cross(lines[i], lines[j])
        if np.linalg.norm(vp) < 1e-12:
            continue
        err = _segment_vp_angle(segs, vp)
        inl = err < np.radians(1.0)
        if best is None or inl.sum() > best.sum():
            best = inl
    return segs[best] if best is not None and best.sum() >= 6 else np.zeros((0, 4))


def _segment_vp_angle(segs: np.ndarray, vp: np.ndarray) -> np.ndarray:
    mid = (segs[:, :2] + segs[:, 2:]) / 2
    sd = segs[:, 2:] - segs[:, :2]
    if abs(vp[2]) < 1e-9 * np.linalg.norm(vp):
        dd = np.tile(vp[:2], (len(segs), 1))
    else:
        dd = vp[:2] / vp[2] - mid
    cross = sd[:, 0] * dd[:, 1] - sd[:, 1] * dd[:, 0]
    sin = np.abs(cross) / (np.linalg.norm(sd, axis=1) * np.linalg.norm(dd, axis=1) + 1e-12)
    return np.arcsin(np.clip(sin, 0, 1))


def calibrate_from_people(samples: np.ndarray, width: int, height: int, hfov: float | None,
                          person_height: float = 1.70,
                          verticals: np.ndarray | None = None) -> tuple[CameraModel, dict] | None:
    if len(samples) < 20 or len(np.unique(samples[:, 4])) < 2:
        return None
    fu, fv, hu, hv = samples[:, 0], samples[:, 1], samples[:, 2], samples[:, 3]
    fit_f = hfov is None

    def build(p):
        pitch, roll, h = p[0], p[1], p[2]
        fov = p[3] if fit_f else hfov
        return CameraModel(intrinsics_from_hfov(width, height, fov), pitch, roll, h)

    def residuals(p):
        cam = build(p)
        F, ok = cam.ground_point_cam(fu, fv)
        Hd = F + person_height * cam.up
        uv = cam.project(Hd)
        r = np.concatenate([uv[:, 0] - hu, uv[:, 1] - hv])
        r[~np.isfinite(r)] = 1e3
        r[np.concatenate([~ok, ~ok])] = 1e3
        if verticals is not None and len(verticals):
            K = cam.K
            up = cam.up
            vp = np.array([K["fx"] * up[0] + K["cx"] * up[2], K["fy"] * up[1] + K["cy"] * up[2], up[2]])
            half = np.linalg.norm(verticals[:, 2:] - verticals[:, :2], axis=1) / 2
            # balance: a few dozen precise edges must weigh as much as ~1000 noisy boxes
            w_v = np.sqrt(len(r) / len(verticals))
            r = np.concatenate([r, np.sin(_segment_vp_angle(verticals, vp)) * half * w_v])
        return r

    best = None
    fovs = [50.0, 70.0, 90.0] if fit_f else [hfov]
    for pitch0 in np.radians([8, 18, 30, 45]):
        for h0 in (2.5, 5.0, 10.0):
            for fov0 in fovs:
                x0 = [pitch0, 0.0, h0] + ([fov0] if fit_f else [])
                lo = [np.radians(-5), np.radians(-15), 0.3] + ([25.0] if fit_f else [])
                hi = [np.radians(85), np.radians(15), 80.0] + ([120.0] if fit_f else [])
                try:
                    r = least_squares(residuals, x0, bounds=(lo, hi), loss="soft_l1", f_scale=4.0)
                except ValueError:
                    continue
                if best is None or r.cost < best.cost:
                    best = r
    if best is None:
        return None
    cam = build(best.x)
    res = residuals(best.x)
    n = len(samples)
    err = np.hypot(res[:n], res[n:2 * n])
    vert_err = res[2 * n:] / (np.sqrt(2 * n / len(verticals)) if verticals is not None and len(verticals) else 1)
    inl = err < 8
    # uncertainty of the parameters from the Jacobian (rough, assumes Gaussian pixel noise)
    try:
        J = best.jac
        sigma2 = np.median(err[inl]) ** 2 if inl.any() else np.median(err) ** 2
        cov = np.linalg.pinv(J.T @ J) * sigma2
        std = np.sqrt(np.clip(np.diag(cov), 0, None))
    except Exception:  # pragma: no cover
        std = np.full(len(best.x), np.nan)
    report = {
        "method": "persone come riferimento (altezza media assunta %.2f m)" % person_height,
        "assumed_person_height_m": person_height,
        "samples": int(n), "people": int(len(np.unique(samples[:, 4]))),
        "inlier_ratio": float(inl.mean()),
        "median_reprojection_px": float(np.median(err)),
        "std_pitch_deg": float(np.degrees(std[0])), "std_roll_deg": float(np.degrees(std[1])),
        "std_height_m": float(std[2]),
        "focal_estimated": fit_f,
        "vertical_lines": int(len(verticals)) if verticals is not None else 0,
        "vertical_lines_median_px": float(np.median(np.abs(vert_err))) if len(vert_err) else None,
    }
    if fit_f:
        report["std_hfov_deg"] = float(std[3])
    log(f"Calibrazione: inclinazione {np.degrees(cam.pitch):.1f} deg, rollio {np.degrees(cam.roll):.1f} deg, "
        f"altezza camera {cam.height:.2f} m, FOV orizz. {cam.hfov_deg:.1f} deg, "
        f"errore mediano {report['median_reprojection_px']:.1f} px su {n} osservazioni")
    return cam, report


def calibrate_from_depth(disp: np.ndarray, width: int, height: int, hfov: float,
                         cam_height: float) -> tuple[CameraModel, dict, tuple[float, float]]:
    """Fallback when no people are visible: fit the floor plane in the depth map's lower part."""
    K = intrinsics_from_hfov(width, height, hfov)
    cam = CameraModel(K)
    vs, us = np.mgrid[int(height * 0.6):height:4, 0:width:4]
    d = disp[vs, us]
    ok = d > np.percentile(disp, 5) + 1e-6
    z = 1.0 / d[ok]
    P = cam.rays(us[ok], vs[ok]) * z[:, None]
    rng = np.random.default_rng(0)
    best_n, best_inl = None, None
    for _ in range(300):
        a, b, c = P[rng.choice(len(P), 3, replace=False)]
        n = np.cross(b - a, c - a)
        if np.linalg.norm(n) < 1e-12:
            continue
        n /= np.linalg.norm(n)
        dist = np.abs((P - a) @ n)
        inl = dist < 0.02 * np.median(z)
        if best_inl is None or inl.sum() > best_inl.sum():
            best_n, best_inl = n, inl
    Q = P[best_inl]
    c0 = Q.mean(0)
    n = np.linalg.svd(Q - c0)[2][-1]
    if n[1] > 0:  # make it point up (OpenCV y is down)
        n = -n
    rel_h = abs(c0 @ n)
    pitch = float(np.arcsin(np.clip(-n[2], -1, 1)))
    roll = float(np.arctan2(n[0], -n[1]))
    cam = CameraModel(K, pitch, roll, cam_height)
    k = cam_height / rel_h  # metric z = k / disp
    report = {"method": "piano del suolo dalla profondita' (nessuna persona utilizzabile)",
              "assumed_camera_height_m": cam_height, "inlier_ratio": float(best_inl.mean()),
              "warning": "Scala non verificata: calibrarla nel visualizzatore con una misura nota."}
    log("Calibrazione di ripiego dal piano del suolo; scala basata su altezza camera ipotetica "
        f"{cam_height} m")
    return cam, report, (k, 0.0)


def fit_disparity_to_metric(disp: np.ndarray, cam: CameraModel, samples: np.ndarray):
    """Find a, b such that disp ~= a / z + b at ground pixels where people walked."""
    h, w = disp.shape
    pts = []
    for fu, fv, *_ in samples:
        for du in (-3, 0, 3):
            u, v = int(round(fu + du)), int(round(fv + 2))
            if 0 <= u < w and 0 <= v < h:
                pts.append((u, v))
    pts = np.array(pts)
    z, ok = cam.ground_depth(pts[:, 0], pts[:, 1])
    x = 1.0 / z[ok]
    y = disp[pts[ok, 1], pts[ok, 0]]
    rng = np.random.default_rng(0)
    best = (None, -1)
    for _ in range(500):
        i, j = rng.choice(len(x), 2, replace=False)
        if abs(x[i] - x[j]) < 1e-9:
            continue
        a = (y[i] - y[j]) / (x[i] - x[j])
        if a <= 0:
            continue
        b = y[i] - a * x[i]
        inl = np.abs(y - (a * x + b)) < 0.05 * (np.ptp(y) + 1e-9)
        if inl.sum() > best[1]:
            best = (inl, inl.sum())
    inl = best[0] if best[0] is not None else np.ones_like(x, bool)
    A = np.stack([x[inl], np.ones(inl.sum())], 1)
    a, b = np.linalg.lstsq(A, y[inl], rcond=None)[0]
    if a <= 0:
        raise RuntimeError("fit profondita' non valido")
    return float(a), float(b), float(inl.mean())


def ground_sigma(cam: CameraModel, u, v, bbox_h, px_err: float = 2.0):
    """1-sigma position error (m) on the ground from feet-localisation uncertainty in pixels."""
    e = px_err + 0.03 * np.asarray(bbox_h)
    a, ok1 = cam.ground_point_cam(u, np.asarray(v) - e)
    b, ok2 = cam.ground_point_cam(u, np.asarray(v) + e)
    s = np.linalg.norm(a - b, axis=-1) / 2
    return np.where(ok1 & ok2, s, np.nan)
