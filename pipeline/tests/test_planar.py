"""Synthetic scene: floor, a wall and a post in front of it, with a blurred depth map like
the one a monocular network returns. The post must stand on its own (not be flattened on the
floor nor glued to the wall), the floor must be floor, the wall a wall."""
import cv2
import numpy as np

from sopralluogo.geometry import CameraModel, intrinsics_from_hfov
from sopralluogo.planar import scene_surfaces

W, H = 640, 360
POST = np.array([1.5, -14.0])  # world x, z of the post axis
WALL_Z = -30.0


def render():
    cam = CameraModel(intrinsics_from_hfov(W, H, 60.0), pitch=np.radians(12), roll=0.0, height=5.0)
    T = cam.world_from_cam()
    R, C = T[:3, :3], T[:3, 3]
    vs, us = np.mgrid[0:H, 0:W]
    rc = cam.rays(us + 0.5, vs + 0.5)
    rw = rc @ R.T
    t = np.full((H, W), np.inf)
    kind = np.zeros((H, W), np.uint8)  # 1 floor, 2 wall, 3 post
    with np.errstate(divide="ignore", invalid="ignore"):
        tf = np.where(rw[..., 1] < 0, -C[1] / rw[..., 1], np.inf)
        tw = np.where(rw[..., 2] < 0, (WALL_Z - C[2]) / rw[..., 2], np.inf)
    hit_w = (tw < tf) & ((C[1] + tw * rw[..., 1]) < 12)
    t = np.where(tf < np.inf, tf, t); kind[tf < np.inf] = 1
    t = np.where(hit_w, tw, t); kind[hit_w] = 2
    # vertical cylinder r = 0.25, height 4
    dx, dz = rw[..., 0], rw[..., 2]
    ox, oz = C[0] - POST[0], C[2] - POST[1]
    a = dx * dx + dz * dz
    bq = 2 * (ox * dx + oz * dz)
    cq = ox * ox + oz * oz - 0.25 ** 2
    disc = bq * bq - 4 * a * cq
    with np.errstate(invalid="ignore"):
        tp = (-bq - np.sqrt(disc)) / (2 * a)
    yp = C[1] + tp * rw[..., 1]
    hit_p = (disc > 0) & (tp > 0) & (yp > 0) & (yp < 4) & (tp < t)
    t = np.where(hit_p, tp, t); kind[hit_p] = 3
    z = t  # rays have z = 1 in camera coordinates, so t is the depth
    disp = np.where(np.isfinite(z), 1.0 / z, 0.0).astype(np.float32)
    disp = cv2.GaussianBlur(disp, (0, 0), 2.5)  # the network smooths across edges
    rng = np.random.default_rng(0)
    img = np.zeros((H, W, 3), np.uint8)
    img[kind == 1] = (150, 160, 150)
    img[kind == 2] = (60, 80, 170)
    img[kind == 3] = (40, 40, 40)
    img = np.clip(img.astype(int) + rng.integers(-12, 12, img.shape), 0, 255).astype(np.uint8)
    height = np.where(hit_p, yp, 0.0)
    return cam, img, disp, kind, height


def test_post_stands_floor_is_floor_wall_is_wall():
    cam, img, disp, kind, height = render()
    z, labels, planes, seg, _ = scene_surfaces(img, disp, 1.0, 0.0, cam, max_depth=80)
    post = cv2.erode((kind == 3).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    floor = cv2.erode((kind == 1).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    wall = cv2.erode((kind == 2).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    # the post is not floor: at most its very foot, where post and floor meet at one depth
    assert (labels[post & (height > 0.6)] == 1).mean() < 0.01
    assert (labels[floor] == 1).mean() > 0.9            # the floor is floor
    assert (labels[wall] >= 2).mean() > 0.8             # the wall is a wall
    assert len(planes) >= 1
    vs, us = np.nonzero(post & np.isfinite(z))
    P = cam.cam_to_world(cam.rays(us + 0.5, vs + 0.5) * z[vs, us, None])
    d = np.hypot(P[:, 0] - POST[0], P[:, 2] - POST[1])
    assert np.median(d) < 0.8                            # where it really is
    assert np.ptp(np.percentile(P[:, 2], [10, 90])) < 1.0  # upright: not stretched along the view
