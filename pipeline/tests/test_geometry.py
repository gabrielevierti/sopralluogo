"""Geometry sanity checks: a synthetic camera must be recovered from synthetic people and edges."""
import numpy as np

from sopralluogo.calibrate import calibrate_from_people
from sopralluogo.geometry import CameraModel, intrinsics_from_hfov, similarity_2d


def make_cam():
    return CameraModel(intrinsics_from_hfov(1280, 720, 55.0), pitch=np.radians(14), roll=np.radians(1.5), height=5.0)


def test_ground_roundtrip():
    cam = make_cam()
    u, v = np.array([200.0, 640.0, 1100.0]), np.array([500.0, 600.0, 700.0])
    P, ok = cam.ground_point_cam(u, v)
    assert ok.all()
    assert np.allclose(cam.project(P), np.stack([u, v], 1), atol=1e-6)
    W = cam.cam_to_world(P)
    assert np.allclose(W[:, 1], 0.0, atol=1e-9)  # on the floor
    assert np.allclose(cam.cam_to_world(np.zeros(3)), [0, 5.0, 0])  # camera height


def test_object_height():
    cam = make_cam()
    F, _ = cam.ground_point_cam(np.array([640.0]), np.array([600.0]))
    head = cam.project(F + 1.8 * cam.up)
    assert np.allclose(cam.object_height(F, head[:, 1]), 1.8, atol=1e-6)


def test_calibration_recovers_camera():
    true = make_cam()
    rng = np.random.default_rng(1)
    rows = []
    for pid in range(12):
        x0, z0 = rng.uniform(-8, 8), rng.uniform(12, 40)
        for k in range(15):
            Pw = np.array([x0 + 0.1 * k, 0.0, -(z0 + 0.1 * k)])
            # world -> camera
            T = true.world_from_cam()
            Pc = T[:3, :3].T @ (Pw - T[:3, 3])
            Hc = Pc + 1.70 * true.up
            f, h = true.project(Pc), true.project(Hc)
            noise = rng.normal(0, 0.7, 4)
            rows.append((f[0] + noise[0], f[1] + noise[1], h[0] + noise[2], h[1] + noise[3], pid))
    cam, rep = calibrate_from_people(np.array(rows), 1280, 720, hfov=55.0)
    assert abs(np.degrees(cam.pitch) - 14) < 0.5
    assert abs(cam.height - 5.0) < 0.15


def test_similarity():
    rng = np.random.default_rng(0)
    src = rng.normal(size=(10, 2))
    a = 0.7
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    dst = 1.1 * src @ R.T + [3, -2]
    s, R2, t, rms = similarity_2d(src, dst)
    assert abs(s - 1.1) < 1e-9 and np.allclose(R2, R) and rms < 1e-9


def test_color_names():
    from sopralluogo.appearance import color_name
    assert color_name((10, 10, 10)) == "nero"
    assert color_name((240, 240, 240)) == "bianco"
    assert color_name((200, 30, 30)) == "rosso"
    assert color_name((40, 70, 170)) == "blu"
    assert color_name((50, 140, 60)) == "verde"


def test_vertical_planes_flatten_wall():
    from sopralluogo.reconstruct import snap_vertical_planes
    cam = make_cam()
    h, w = 720, 1280
    vs, us = np.mgrid[0:h, 0:w]
    zg, okg = cam.ground_depth(us, vs)
    # a wall 30 m in front of the camera (world z = -30), with noisy depth
    T = cam.world_from_cam()
    r = cam.rays(us, vs) @ T[:3, :3].T
    s = (-30.0 - T[2, 3]) / r[..., 2]
    zw = s.copy()
    use_wall = (~okg) | (zw < zg)
    z = np.where(use_wall, zw, zg) * (1 + np.random.default_rng(0).normal(0, 0.02, (h, w)) * use_wall)
    z, labels, _ = snap_vertical_planes(z, okg & ~use_wall, cam)
    wall = labels >= 2
    assert wall.sum() > 0.5 * use_wall.sum()
    # noise was 2% per pixel: the fitted wall must be far more accurate than that, and flat
    assert np.allclose(z[wall], zw[wall], rtol=5e-3)
