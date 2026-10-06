"""Build the measurable 3D scene: static surface mesh + metric trajectories."""
from __future__ import annotations

import numpy as np
from scipy.signal import savgol_filter

from .calibrate import ground_sigma
from .geometry import CameraModel


def metric_depth(disp: np.ndarray, a: float, b: float, cam: CameraModel, max_depth: float,
                 snap_tol: float = 0.10):
    """Metric depth map + mask of pixels that lie on the ground plane."""
    h, w = disp.shape
    denom = disp - b
    valid = denom > 1e-6 * max(abs(a), 1e-9)
    z = np.where(valid, a / np.where(valid, denom, 1.0), np.nan)
    vs, us = np.mgrid[0:h, 0:w]
    zp, okp = cam.ground_depth(us, vs)
    ground = okp & valid & (np.abs(z - zp) < snap_tol * zp)
    z = np.where(ground, zp, z)  # snap: the floor becomes a true plane (no neural-net ripples)
    valid &= (z > 0.2) & (z < max_depth)
    z[~valid] = np.nan
    return z, ground & valid


def depth_mesh(bgr: np.ndarray, z: np.ndarray, ground: np.ndarray, cam: CameraModel,
               stride: int = 2, edge_ratio: float = 1.08):
    """Triangulate the depth grid. Faces across depth discontinuities are dropped."""
    h, w = z.shape
    vs, us = np.mgrid[0:h:stride, 0:w:stride]
    gh, gw = vs.shape
    zz = z[vs, us]
    gg = ground[vs, us]
    pc = cam.rays(us + 0.5, vs + 0.5) * zz[..., None]
    pw = cam.cam_to_world(pc.reshape(-1, 3)).astype(np.float32)
    col = bgr[vs, us][..., ::-1].reshape(-1, 3).astype(np.uint8)
    valid = np.isfinite(zz)

    idx = np.arange(gh * gw).reshape(gh, gw)
    a, b = idx[:-1, :-1], idx[:-1, 1:]
    c, d = idx[1:, :-1], idx[1:, 1:]
    za, zb, zc, zd = zz[:-1, :-1], zz[:-1, 1:], zz[1:, :-1], zz[1:, 1:]
    va = valid[:-1, :-1] & valid[:-1, 1:] & valid[1:, :-1] & valid[1:, 1:]
    with np.errstate(invalid="ignore"):
        zmax = np.fmax(np.fmax(za, zb), np.fmax(zc, zd))
        zmin = np.fmin(np.fmin(za, zb), np.fmin(zc, zd))
        smooth = zmax / zmin < edge_ratio
    allg = gg[:-1, :-1] & gg[:-1, 1:] & gg[1:, :-1] & gg[1:, 1:]
    keep = va & (smooth | allg)
    tris = np.concatenate([np.stack([a, c, b], -1)[keep], np.stack([b, c, d], -1)[keep]])
    # compact: drop unused vertices
    used = np.zeros(len(pw), bool)
    used[tris.ravel()] = True
    remap = -np.ones(len(pw), np.int64)
    remap[used] = np.arange(used.sum())
    return pw[used], col[used], remap[tris].astype(np.uint32), {
        "vertices": int(used.sum()), "faces": int(len(tris)), "grid_stride": stride}


def trajectories(tracks, cam: CameraModel, fps: float, stride: int, width: int, height: int,
                 max_gap: int) -> list[dict]:
    result = []
    for t in tracks:
        frames = np.array([f for f, _ in t.obs])
        boxes = np.array([d["bbox"] for _, d in t.obs], dtype=float)
        confs = np.array([d["conf"] for _, d in t.obs])
        # fill short gaps (missed detections) on the processing grid, flagged as interpolated
        grid = np.arange(frames[0], frames[-1] + 1, stride)
        interp = ~np.isin(grid, frames)
        # do not bridge long gaps
        gaps = np.diff(frames)
        long_gap = np.zeros(len(grid), bool)
        for f0, g in zip(frames[:-1], gaps):
            if g > max_gap:
                long_gap |= (grid > f0) & (grid < f0 + g)
        grid, interp = grid[~long_gap], interp[~long_gap]
        B = np.stack([np.interp(grid, frames, boxes[:, k]) for k in range(4)], 1)
        C = np.interp(grid, frames, confs)

        u = (B[:, 0] + B[:, 2]) / 2
        v = B[:, 3]
        foot_cam, ok = cam.ground_point_cam(u, v)
        if ok.sum() < 3:
            continue
        P = cam.cam_to_world(foot_cam)
        sig = ground_sigma(cam, u, v, B[:, 3] - B[:, 1])
        t_s = grid / fps
        sel = ok & np.isfinite(P).all(1)
        P, t_s, B, C, sig, interp, foot_cam, grid = (P[sel], t_s[sel], B[sel], C[sel], sig[sel],
                                                     interp[sel], foot_cam[sel], grid[sel])
        n = len(P)
        win = int(round(fps / stride * 0.8)) | 1  # ~0.8 s, odd
        if n >= 5:
            win = min(win, n if n % 2 else n - 1)
            Ps = P.copy()
            if win >= 5:
                Ps[:, 0] = savgol_filter(P[:, 0], win, 2)
                Ps[:, 2] = savgol_filter(P[:, 2], win, 2)
        else:
            Ps = P
        # Speed over a +-1 s window: per-frame differences mostly measure detector jitter,
        # a 2 s baseline measures actual motion.
        half = 1.0
        ta = np.clip(t_s - half, t_s[0], t_s[-1])
        tb = np.clip(t_s + half, t_s[0], t_s[-1])
        pa = np.stack([np.interp(ta, t_s, Ps[:, 0]), np.interp(ta, t_s, Ps[:, 2])], 1)
        pb = np.stack([np.interp(tb, t_s, Ps[:, 0]), np.interp(tb, t_s, Ps[:, 2])], 1)
        dt = np.maximum(tb - ta, 1e-6)
        speed = np.where(dt > 0.3, np.linalg.norm(pb - pa, axis=1) / dt, np.nan)
        speed_sigma = np.sqrt(2) * sig / np.maximum(dt, 0.3)
        tg = np.append(np.arange(t_s[0], t_s[-1], 1.0), t_s[-1])
        pg = np.stack([np.interp(tg, t_s, Ps[:, 0]), np.interp(tg, t_s, Ps[:, 2])], 1)
        seg = np.linalg.norm(np.diff(pg, axis=0), axis=1)

        heights = np.full(n, np.nan)
        if t.cls == "persona":
            m = 3
            full = (B[:, 0] > m) & (B[:, 1] > m) & (B[:, 2] < width - m) & (B[:, 3] < height - m) & ~interp
            heights[full] = cam.object_height(foot_cam[full], B[full, 1])
        hv = heights[np.isfinite(heights)]
        stats = {
            "start_s": float(t_s[0]), "end_s": float(t_s[-1]), "duration_s": float(t_s[-1] - t_s[0]),
            "path_m": float(seg.sum()),
            "mean_speed_kmh": float(seg.sum() / max(t_s[-1] - t_s[0], 1e-6) * 3.6),
            "median_speed_kmh": float(np.nanmedian(speed) * 3.6) if np.isfinite(speed).any() else None,
            "max_speed_kmh": float(np.nanpercentile(speed, 90) * 3.6) if np.isfinite(speed).sum() > 3 else None,
            "speed_sigma_kmh": float(np.nanmedian(speed_sigma) * 3.6),
            "median_sigma_m": float(np.nanmedian(sig)),
            "interpolated_ratio": float(interp.mean()),
        }
        if len(hv) >= 3:
            stats.update({"height_m": float(np.median(hv)),
                          "height_iqr_m": [float(np.percentile(hv, 25)), float(np.percentile(hv, 75))],
                          "height_samples": int(len(hv))})
        result.append({
            "id": t.id, "cls": t.cls,
            "t": np.round(t_s, 4).tolist(),
            "frame": grid.astype(int).tolist(),
            "p": np.round(Ps[:, [0, 2]], 3).tolist(),
            "p_raw": np.round(P[:, [0, 2]], 3).tolist(),
            "sigma": np.round(sig, 3).tolist(),
            "speed": [None if not np.isfinite(x) else round(float(x) * 3.6, 2) for x in speed],
            "h": [None if not np.isfinite(x) else round(float(x), 3) for x in heights],
            "bbox": np.round(B, 1).tolist(),
            "conf": np.round(C, 3).tolist(),
            "interp": interp.astype(int).tolist(),
            "stats": stats,
        })
    return result
