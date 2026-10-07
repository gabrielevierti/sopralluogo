"""Build the measurable 3D scene: static surface mesh + metric trajectories."""
from __future__ import annotations

import cv2
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


def snap_vertical_planes(z: np.ndarray, ground: np.ndarray, cam: CameraModel, max_planes: int = 8):
    """Find building walls (vertical planes) in the depth map and make them truly flat.

    Neural depth gives walls a wavy, smeared look; man-made scenes are mostly planes.
    Returns the corrected depth and a label map: 0 = free surface, 1 = ground, 2.. = walls.
    """
    h, w = z.shape
    labels = np.zeros((h, w), np.int32)
    labels[ground] = 1
    planes = []
    vs, us = np.mgrid[0:h, 0:w]
    rays = cam.rays(us, vs)
    Pc = rays * z[..., None]
    Pw = cam.cam_to_world(Pc.reshape(-1, 3)).reshape(h, w, 3)
    free = np.isfinite(z) & ~ground & (Pw[..., 1] > 0.15)
    min_px = max(1500, int(0.004 * h * w))
    rng = np.random.default_rng(0)
    T = cam.world_from_cam()
    C = T[:3, 3]
    for k in range(max_planes):
        idx = np.flatnonzero(free.ravel())
        if len(idx) < min_px:
            break
        sub = idx[rng.choice(len(idx), min(len(idx), 20000), replace=False)]
        xz = Pw.reshape(-1, 3)[sub][:, [0, 2]]
        dep = z.ravel()[sub]
        best, best_n = None, 0
        for _ in range(250):
            i, j = rng.choice(len(sub), 2, replace=False)
            d = xz[j] - xz[i]
            nrm = np.linalg.norm(d)
            if nrm < 0.5:
                continue
            n = np.array([-d[1], d[0]]) / nrm
            res = np.abs((xz - xz[i]) @ n)
            inl = res < 0.03 * dep + 0.08
            if inl.sum() > best_n:
                best, best_n = (n, float(n @ xz[i])), int(inl.sum())
        if best is None or best_n < 0.04 * len(sub):
            break
        n, off = best
        # refine on all inliers (total least squares line in the ground plane)
        allxz = Pw[..., [0, 2]]
        res = np.abs(allxz @ n - off)
        inl = free & (res < 0.03 * z + 0.08)
        pts = allxz[inl]
        c0 = pts.mean(0)
        n = np.linalg.svd(pts - c0, full_matrices=False)[2][-1]
        off = float(n @ c0)
        res = np.abs(allxz @ n - off)
        inl = free & (res < 0.035 * z + 0.08)
        # only large connected regions: a tree trunk that happens to touch the plane stays free
        ncomp, comp, stats, _ = cv2.connectedComponentsWithStats(inl.astype(np.uint8), connectivity=8)
        keep = np.zeros_like(inl)
        for ci in range(1, ncomp):
            if stats[ci, cv2.CC_STAT_AREA] >= min_px:
                keep |= comp == ci
        if not keep.any():
            free &= ~inl
            continue
        # a plane seen almost edge-on (e.g. a row of trees along the view) is not trustworthy:
        # leave it as a free surface, so the grazing filter can thin it out
        rays_w = rays[keep] @ T[:3, :3].T
        rays_w /= np.linalg.norm(rays_w, axis=1, keepdims=True)
        facing = float(np.median(np.abs(rays_w[:, [0, 2]] @ n)))
        if facing < 0.25:
            free &= ~keep
            continue
        # ray / plane intersection, in world coordinates: n . (C + s R r)_xz = off
        rw = rays[keep] @ T[:3, :3].T
        denom = rw[:, [0, 2]] @ n
        s_ = (off - C[[0, 2]] @ n) / np.where(np.abs(denom) > 1e-9, denom, np.nan)
        znew = s_  # rays have z = 1 in camera coords, so the scale is the depth
        good = np.isfinite(znew) & (znew > 0)
        zk = z[keep]
        zk[good] = znew[good]
        z[keep] = zk
        labels[keep] = 2 + len(planes)
        planes.append((n, off))
        free &= ~keep
    return z, labels, planes


def depth_mesh(bgr: np.ndarray, z: np.ndarray, labels: np.ndarray, cam: CameraModel,
               stride: int = 2, edge_ratio: float = 1.06, min_view_cos: float = 0.17,
               region: np.ndarray | None = None, soft_cells: float = 6.0,
               segments: np.ndarray | None = None, min_object_faces: int = 60,
               patches: np.ndarray | None = None):
    """Triangulate the depth grid.

    Dropped: faces across depth discontinuities, and free-form faces seen almost edge-on
    from the camera (they are the long "streaks" a single view cannot really know).
    """
    h, w = z.shape
    vs, us = np.mgrid[0:h:stride, 0:w:stride]
    gh, gw = vs.shape
    zz = z[vs, us]
    ll = labels[vs, us]
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
    la = ll[:-1, :-1]
    same = (la > 0) & (la == ll[:-1, 1:]) & (la == ll[1:, :-1]) & (la == ll[1:, 1:])
    keep = va & (smooth | same)
    if segments is not None:
        # superpixels: always join inside one, across two only without a depth jump
        sg = segments[vs, us]
        sa = sg[:-1, :-1]
        one = (sa >= 0) & (sa == sg[:-1, 1:]) & (sa == sg[1:, :-1]) & (sa == sg[1:, 1:])
        with np.errstate(invalid="ignore", divide="ignore"):
            tight = zmax / zmin < 1.035
        keep = va & (one | same | tight)
        if patches is not None:
            # a cell inside one superpixel lies on one fitted plane: its quality is that
            # plane's, not the noise of the depth network
            pg = patches[vs, us]
            pa = pg[:-1, :-1]
            same = same | ((pa >= 0) & (pa == pg[:-1, 1:]) & (pa == pg[1:, :-1]) & (pa == pg[1:, 1:]))
    if region is not None:  # only cells touching this pixel mask (used for the filled layer)
        rg = region[vs, us]
        keep &= rg[:-1, :-1] | rg[:-1, 1:] | rg[1:, :-1] | rg[1:, 1:]
    tris = np.concatenate([np.stack([a, c, b], -1)[keep], np.stack([b, c, d], -1)[keep]])
    planar = np.concatenate([same[keep], same[keep]])
    # grazing test for free-form faces
    A, B, Cc = pw[tris[:, 0]], pw[tris[:, 1]], pw[tris[:, 2]]
    nrm = np.cross(B - A, Cc - A)
    view = (A + B + Cc) / 3 - cam.world_from_cam()[:3, 3]
    with np.errstate(invalid="ignore", divide="ignore"):
        cosv = np.abs((nrm * view).sum(1)) / (np.linalg.norm(nrm, axis=1) * np.linalg.norm(view, axis=1))
    kept = planar | (cosv > min_view_cos)
    tris, cosv, planar = tris[kept], cosv[kept], planar[kept]
    kind = np.where(ll.ravel() == 1, 1, np.where(ll.ravel() >= 2, 2, 0)).astype(np.uint8)
    if segments is not None and len(tris):
        # stretch test: a face of an object much longer in 3D than the pixels it covers is a
        # sheet pulled across a depth jump, never a real surface (floor and walls excepted)
        A, B, Cc = pw[tris[:, 0]], pw[tris[:, 1]], pw[tris[:, 2]]
        edge = np.maximum(np.maximum(np.linalg.norm(B - A, axis=1), np.linalg.norm(Cc - B, axis=1)),
                          np.linalg.norm(A - Cc, axis=1))
        dist = np.linalg.norm((A + B + Cc) / 3 - cam.world_from_cam()[:3, 3], axis=1)
        footprint = dist * stride * 1.5 / cam.K["fx"]
        objf = (kind[tris] == 0).any(1)
        ok = ~objf | (edge < 4.0 * footprint)
        tris, cosv, planar = tris[ok], cosv[ok], planar[ok]
    if segments is not None and len(tris):
        from .planar import drop_small_components
        km = drop_small_components(tris, len(pw), kind, min_object_faces)
        tris, cosv, planar = tris[km], cosv[km], planar[km]
    # per-vertex quality: how squarely the camera saw the surface (1 for ground and walls).
    # The viewer fades low-quality surface instead of drawing hard streaks.
    q = np.zeros(len(pw), np.float32)
    tq = np.where(planar, 1.0, np.clip((cosv - min_view_cos) / 0.35, 0, 1))
    for k in range(3):
        np.maximum.at(q, tris[:, k], tq)
    # soft borders: fade the last few grid cells before any edge of missing information,
    # so the reconstruction ends in a smooth vignette instead of a jagged cut
    used_v = np.zeros(gh * gw, np.uint8)
    used_v[tris.ravel()] = 255
    pad = np.pad(used_v.reshape(gh, gw), 1)
    dist = cv2.distanceTransform(pad, cv2.DIST_L2, 3)[1:-1, 1:-1].ravel()
    soft = np.clip(dist / soft_cells, 0, 1)
    q *= soft * soft * (3 - 2 * soft)
    # compact: drop unused vertices
    used = np.zeros(len(pw), bool)
    used[tris.ravel()] = True
    remap = -np.ones(len(pw), np.int64)
    remap[used] = np.arange(used.sum())
    return pw[used], col[used], (q[used] * 255).astype(np.uint8), remap[tris].astype(np.uint32), kind[used], {
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
        # occlusions bridged by re-identification: shown as dashed in the viewer
        gaps = [[round(f0 / fps, 3), round((f0 + g) / fps, 3)] for f0, g in zip(frames[:-1], gaps) if g > max_gap]
        result.append({
            "id": t.id, "cls": t.cls, "gaps": gaps, "links": getattr(t, "links", []),
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


def building_volumes(planes: list, labels: np.ndarray, z: np.ndarray, bgr: np.ndarray, cam: CameraModel) -> list[dict]:
    """Close each wall into a building block: the visible facade is real, the rest is completed.

    The footprint runs along the wall for the extent actually seen and extends away from
    the camera by a plausible depth; the height is the top of the visible facade.
    Everything except the facade is marked as generated.
    """
    h, w = z.shape
    vs, us = np.mgrid[0:h, 0:w]
    out = []
    for k, (n, off) in enumerate(planes):
        m = labels == 2 + k
        if m.sum() < 500:
            continue
        # vegetation (a row of trees can be planar too) does not become a building
        px = bgr[m].astype(np.float32)
        b_, g_, r_ = px[:, 0], px[:, 1], px[:, 2]
        wb = bgr.reshape(-1, 3).mean(0)  # grey-world correction of the colour cast
        g2 = g_ * wb.mean() / wb[1]
        veg = float(np.mean((2 * g2 - r_ * wb.mean() / wb[2] - b_ * wb.mean() / wb[0]) > 18))
        if veg > 0.3:
            continue
        P = cam.cam_to_world(cam.rays(us[m], vs[m]) * z[m][:, None])
        d = np.array([-n[1], n[0]])
        t = P[:, [0, 2]] @ d
        t0, t1 = np.percentile(t, [2, 98])
        height = float(np.clip(np.percentile(P[:, 1], 97), 2.5, 40.0))
        length = float(t1 - t0)
        if length < 2.0:
            continue
        c0 = n * off
        A, B = c0 + t0 * d, c0 + t1 * d
        depth = float(np.clip(0.6 * length, 6.0, 14.0))
        back = n * depth * np.sign(off if off != 0 else 1.0)  # away from the camera
        rgb = np.median(bgr[m][:, ::-1], axis=0).astype(int).tolist()
        tex = facade_texture(bgr, m, cam, A, d, length, height)
        out.append({"_texture": tex, "vegetation": round(veg, 2), "footprint": [A.tolist(), B.tolist(), (B + back).tolist(), (A + back).tolist()],
                    "height": height, "color": rgb, "facade_length_m": round(length, 2), "depth_m": round(depth, 2)})
    return out


def floor_detail(bgr: np.ndarray, ground: np.ndarray, z: np.ndarray, cam: CameraModel, out_path, res_m: float = 0.01):
    """A tileable close-up texture of the floor, taken where the camera sees it best.

    Far away the floor covers few pixels and looks smeared; the viewer adds this detail
    (only its fine grain, not its colour) where the original image is too coarse.
    """
    zg = np.where(ground, z, np.nan)
    if np.isfinite(zg).sum() < 2000:
        return None
    near = ground & (zg <= np.nanpercentile(zg, 30))
    vs, us = np.nonzero(near)
    P = cam.cam_to_world(cam.rays(us, vs) * z[vs, us][:, None])
    cx, cz = np.median(P[:, 0]), np.median(P[:, 2])
    T = cam.world_from_cam()
    for size in (3.0, 2.0, 1.5, 1.0):
        n = int(size / res_m)
        gx, gz = np.meshgrid(cx + (np.arange(n) - n / 2) * res_m, cz + (np.arange(n) - n / 2) * res_m)
        W = np.stack([gx, np.zeros_like(gx), gz], -1).reshape(-1, 3)
        C = (W - T[:3, 3]) @ T[:3, :3]
        uv = cam.project(C).reshape(n, n, 2).astype(np.float32)
        gm = cv2.remap(ground.astype(np.uint8), uv[..., 0], uv[..., 1], cv2.INTER_NEAREST, borderValue=0)
        if gm.mean() > 0.95:
            tile = cv2.remap(bgr, uv[..., 0], uv[..., 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
            break
    else:
        return None
    # mirror to make it seamless, keep only the fine grain (high-pass around mid grey)
    tile = np.vstack([np.hstack([tile, tile[:, ::-1]]), np.hstack([tile[::-1], tile[::-1, ::-1]])])
    g = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), 6)
    hp = np.clip(128 + hp * 1.6, 0, 255).astype(np.uint8)
    cv2.imwrite(str(out_path), hp, [cv2.IMWRITE_JPEG_QUALITY, 90])
    floor_rgb = np.median(bgr[ground][:, ::-1], axis=0).astype(int).tolist()
    return {"tile_m": round(2 * size, 3), "floor_rgb": floor_rgb}


def save_building_textures(buildings: list[dict], cam_dir, rel: str) -> None:
    for i, b in enumerate(buildings):
        tex = b.pop("_texture", None)
        if tex is not None:
            p = cam_dir / f"facade_{i}.jpg"
            cv2.imwrite(str(p), tex, [cv2.IMWRITE_JPEG_QUALITY, 88])
            b["texture"] = f"{rel}/facade_{i}.jpg"


def drop_buildings_with_people(buildings: list[dict], trajs: list[dict]) -> list[dict]:
    """People cannot walk through walls: discard any completed volume that a trajectory enters."""
    pts = np.array([p for t in trajs for p in t["p"]], dtype=np.float32).reshape(-1, 2)
    kept = []
    for b in buildings:
        poly = np.array(b["footprint"], dtype=np.float32)
        inside = sum(cv2.pointPolygonTest(poly, (float(x), float(z)), True) > 0.3 for x, z in pts) if len(pts) else 0
        b["people_inside"] = int(inside)
        if inside <= 2:
            kept.append(b)
    return kept


def facade_texture(bgr, region, cam: CameraModel, A, d, length: float, height: float, res: float = 0.05):
    """The visible facade, rectified to a flat elevation image; holes are filled (FSR).

    Used to dress the unseen sides of the completed building."""
    from .fill import inpaint_color
    nu, nv = max(int(length / res), 8), max(int(height / res), 8)
    if nu * nv > 4_000_000:
        k = (nu * nv / 4_000_000) ** 0.5
        nu, nv = int(nu / k), int(nv / k)
    tt = np.linspace(0, length, nu)
    yy = np.linspace(height, 0, nv)
    G, Y = np.meshgrid(tt, yy)
    W = np.stack([A[0] + G * d[0], Y, A[1] + G * d[1]], -1).reshape(-1, 3)
    T = cam.world_from_cam()
    C = (W - T[:3, 3]) @ T[:3, :3]
    uv = cam.project(C).reshape(nv, nu, 2).astype(np.float32)
    img = cv2.remap(bgr, uv[..., 0], uv[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    ok = cv2.remap(region.astype(np.uint8), uv[..., 0], uv[..., 1], cv2.INTER_NEAREST, borderValue=0) > 0
    if ok.mean() < 0.15:
        return None
    img, _ = inpaint_color(img, ~ok)
    return img
