"""Piecewise-planar scene surfaces from one image.

Monocular depth is smooth everywhere: across the edge between a lamp post and the floor
behind it, it ramps gradually from one to the other. Meshed per pixel, those ramps become
the long stretched sheets that make a single-view reconstruction unreadable, and global
plane fitting ("is there a vertical plane through these points?") glues unrelated objects
(a lamp post, a bin, a staircase) onto the facade of a building.

Here the image is split into superpixels, which follow colour edges, and every decision is
taken per superpixel, with only adjacent superpixels allowed to join:

- ground: most pixels agree with the calibrated floor plane and the local surface is
  horizontal; only the part connected to the main floor is kept;
- walls: vertical superpixels joined to their neighbours when they lie on the same vertical
  plane *and* there is no depth jump between them; only large groups become walls;
- everything else (objects, stairs, vegetation): a small plane per superpixel, fitted
  robustly, so the ramp pixels at the borders no longer drag the surface.

The returned `segments` map lets the mesher cut faces where two superpixels are at
different depths: objects stand free instead of being joined to what is behind them.
"""
from __future__ import annotations

import cv2
import numpy as np

from .geometry import CameraModel


class _UF:
    def __init__(self, n):
        self.p = np.arange(n)

    def find(self, a):
        p = self.p
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


def superpixels(bgr: np.ndarray, size: int = 14) -> tuple[np.ndarray, int]:
    lab = cv2.cvtColor(cv2.GaussianBlur(bgr, (3, 3), 0), cv2.COLOR_BGR2LAB)
    slic = cv2.ximgproc.createSuperpixelSLIC(lab, algorithm=cv2.ximgproc.SLICO, region_size=size)
    slic.iterate(8)
    slic.enforceLabelConnectivity(max(4, size * size // 4))
    return slic.getLabels().astype(np.int32), int(slic.getNumberOfSuperpixels())


def _adjacency(sp: np.ndarray) -> np.ndarray:
    a = np.concatenate([sp[:, :-1].ravel(), sp[:-1, :].ravel()])
    b = np.concatenate([sp[:, 1:].ravel(), sp[1:, :].ravel()])
    m = a != b
    pairs = np.stack([np.minimum(a[m], b[m]), np.maximum(a[m], b[m])], 1)
    return np.unique(pairs, axis=0)


def _plane_stats(P: np.ndarray, sp: np.ndarray, valid: np.ndarray, n: int):
    """Per-superpixel centroid, normal and flatness from the 3D points (vectorised)."""
    idx = sp[valid]
    X = P[valid]
    cnt = np.bincount(idx, minlength=n).astype(np.float64)
    c = np.stack([np.bincount(idx, X[:, k], n) for k in range(3)], 1) / np.maximum(cnt, 1)[:, None]
    cov = np.zeros((n, 3, 3))
    for i in range(3):
        for j in range(i, 3):
            s = np.bincount(idx, X[:, i] * X[:, j], n) / np.maximum(cnt, 1) - c[:, i] * c[:, j]
            cov[:, i, j] = cov[:, j, i] = s
    w, v = np.linalg.eigh(cov + np.eye(3) * 1e-9)
    normal = v[:, :, 0]
    flat = w[:, 0] / np.maximum(w[:, 1], 1e-12)
    return cnt, c, normal, flat


def scene_surfaces(bgr: np.ndarray, disp: np.ndarray, a: float, b: float, cam: CameraModel,
                   max_depth: float, ground_tol: float = 0.08, sp_size: int = 14):
    """Returns z (metric depth, NaN = no surface), labels (0 free, 1 ground, 2.. walls),
    planes [(n_xz, offset)] for the walls, segments (object id per pixel, -1 = none) and
    patches (superpixel id per pixel: each one is a single plane)."""
    h, w = disp.shape
    denom = disp - b
    ok = denom > 1e-6 * max(abs(a), 1e-9)
    z = np.where(ok, a / np.where(ok, denom, 1.0), np.nan)
    valid = ok & (z > 0.2) & (z < max_depth)
    z[~valid] = np.nan

    vs, us = np.mgrid[0:h, 0:w]
    rays = cam.rays(us, vs)
    T = cam.world_from_cam()
    R, C = T[:3, :3], T[:3, 3]
    zp, okp = cam.ground_depth(us, vs)
    zp = np.where(okp, zp, np.nan)
    P = cam.cam_to_world((rays * np.nan_to_num(z)[..., None]).reshape(-1, 3)).reshape(h, w, 3)

    sp, n = superpixels(bgr, sp_size)
    cnt, cen, nrm, flat = _plane_stats(P, sp, valid, n)
    area = np.bincount(sp.ravel(), minlength=n)
    agree = valid & okp & (np.abs(z - zp) < ground_tol * zp)
    agree_frac = np.bincount(sp[agree], minlength=n) / np.maximum(area, 1)
    up = np.abs(nrm[:, 1])
    adj = _adjacency(sp)
    nbrs = [[] for _ in range(n)]
    for i, j in adj:
        nbrs[i].append(j)
        nbrs[j].append(i)

    # ---- ground: agrees with the floor plane, locally horizontal, connected to the main floor
    is_ground = (agree_frac > 0.6) & ((up > 0.75) | (agree_frac > 0.9))
    uf = _UF(n)
    for i, j in adj:
        if is_ground[i] and is_ground[j]:
            uf.union(i, j)
    roots = np.array([uf.find(i) for i in range(n)])
    if is_ground.any():
        sizes = np.bincount(roots[is_ground], weights=area[is_ground], minlength=n)
        main = int(np.argmax(sizes))
        is_ground &= (roots == main) | (sizes[roots] > 0.25 * sizes[main])

    labels = np.zeros((h, w), np.int32)
    gpix = is_ground[sp] & okp
    # a superpixel can straddle the edge of a thin object (a post seen against the floor):
    # its pixels clearly in front of the floor are not floor. Projected onto the floor
    # they would become a long dark streak, so they get no surface at all.
    front = gpix & valid & (z < (1 - 1.5 * ground_tol) * zp)
    gpix &= ~front
    valid &= ~front
    z[front] = np.nan
    labels[gpix] = 1
    z = np.where(gpix, zp, z)  # the floor is an exact plane

    # ---- walls: adjacent vertical superpixels on one vertical plane, with no depth jump
    medz = np.bincount(sp[valid], z[valid], n) / np.maximum(cnt, 1)
    sp_ray = np.stack([np.bincount(sp.ravel(), rays[..., k].ravel(), n) for k in range(3)], 1) / np.maximum(area, 1)[:, None]
    hn = nrm[:, [0, 2]] / np.maximum(np.linalg.norm(nrm[:, [0, 2]], axis=1, keepdims=True), 1e-9)
    vertical = (~is_ground) & (cnt > 0.5 * area) & (up < 0.35) & (flat < 0.25) & (cen[:, 1] > 0.1)
    uf = _UF(n)
    for i, j in adj:
        if not (vertical[i] and vertical[j]):
            continue
        if abs(hn[i] @ hn[j]) < np.cos(np.radians(14)):
            continue
        tol = 0.04 * max(medz[i], medz[j]) + 0.12
        if abs((cen[j, [0, 2]] - cen[i, [0, 2]]) @ hn[i]) > tol or abs((cen[i, [0, 2]] - cen[j, [0, 2]]) @ hn[j]) > tol:
            continue
        if abs(medz[i] - medz[j]) > 0.12 * min(medz[i], medz[j]) + 0.3:
            continue
        uf.union(i, j)
    roots = np.array([uf.find(i) for i in range(n)])
    min_px = max(2500, int(0.004 * h * w))
    planes = []
    is_wall = np.zeros(n, bool)
    group_area = np.bincount(roots[vertical], weights=area[vertical], minlength=n)
    for r in np.flatnonzero(group_area >= min_px):
        members = np.flatnonzero(vertical & (roots == r))
        m = np.isin(sp, members) & valid & ~gpix
        if m.sum() < min_px * 0.5:
            continue
        xz = P[m][:, [0, 2]]
        if len(xz) > 30000:
            xz = xz[np.random.default_rng(0).choice(len(xz), 30000, replace=False)]
        c0 = np.median(xz, 0)
        nn = np.linalg.svd(xz - c0, full_matrices=False)[2][-1]
        res = np.abs((xz - c0) @ nn)
        keep = res < np.percentile(res, 70) + 1e-6  # refit on the best 70%
        c0 = xz[keep].mean(0)
        nn = np.linalg.svd(xz[keep] - c0, full_matrices=False)[2][-1]
        off = float(nn @ c0)
        def plane_depth(j):
            # depth of the plane along this superpixel's own viewing ray: near a grazing plane
            # a point can be close to the plane and still metres away along the ray
            r = R @ sp_ray[j]
            d = float(r[[0, 2]] @ nn)
            return (off - float(C[[0, 2]] @ nn)) / d if abs(d) > 1e-9 else np.inf

        # grow over the neighbouring superpixels that lie on the same plane (window frames,
        # signs, the ragged border a flatness test alone leaves free)
        cur = set(members.tolist())
        for _ in range(6):
            cand = {j for i in cur for j in nbrs[i]} - cur
            add = [j for j in cand if not is_ground[j] and not is_wall[j] and cnt[j] > 0.3 * area[j]
                   and up[j] < 0.7 and abs(float(cen[j, [0, 2]] @ nn) - off) < 0.03 * medz[j] + 0.15
                   and abs(plane_depth(j) - medz[j]) < 0.05 * medz[j] + 0.1]
            if not add:
                break
            cur.update(add)
        members = np.array(sorted(cur))
        m = np.isin(sp, members) & valid & ~gpix
        rw = rays[m] @ R.T
        rwn = rw / np.linalg.norm(rw, axis=1, keepdims=True)
        if float(np.median(np.abs(rwn[:, [0, 2]] @ nn))) < 0.25:
            continue  # seen almost edge-on: not trustworthy as a wall
        den = rw[:, [0, 2]] @ nn
        znew = (off - C[[0, 2]] @ nn) / np.where(np.abs(den) > 1e-9, den, np.nan)
        zold = z[m]
        good = np.isfinite(znew) & (znew > 0) & (np.abs(znew - zold) < 0.12 * zold)
        zz = zold.copy()
        zz[good] = znew[good]
        z[m] = zz
        is_wall[members] = True
        labels[m] = 2 + len(planes)
        planes.append((nn, off))

    # ---- everything else: objects = adjacent free superpixels with continuous depth.
    # One robust plane per object when it fits (a post, a bin, a flight of stairs, a hedge),
    # otherwise one per superpixel; inside an object the mesh is never cut, so it stays whole.
    free = ~is_ground & ~is_wall & (cnt > 8)
    uf = _UF(n)
    for i, j in adj:
        if not (free[i] and free[j]):
            continue
        zm = min(medz[i], medz[j])
        if abs(medz[i] - medz[j]) > 0.07 * zm + 0.15:
            continue
        # and roughly on one surface: a post and the tree canopy behind it touch in the
        # image at similar depth, but are not one plane
        tol = 0.05 * zm + 0.12
        if abs((cen[j] - cen[i]) @ nrm[i]) > tol or abs((cen[i] - cen[j]) @ nrm[j]) > tol:
            continue
        uf.union(i, j)
    obj = np.array([uf.find(i) for i in range(n)])
    order = np.argsort(sp.ravel(), kind="stable")
    bounds = np.concatenate([[0], np.cumsum(area)])
    zf, vf = z.ravel(), valid.ravel()
    raysf = rays.reshape(-1, 3)

    def robust_plane(X):
        c0 = np.median(X, 0)
        sel = np.ones(len(X), bool)
        for _ in range(3):
            nn = np.linalg.svd(X[sel] - c0, full_matrices=False)[2][-1]
            res = np.abs((X - c0) @ nn)
            sel = res <= np.percentile(res, 65)
            c0 = X[sel].mean(0)
        nn = np.linalg.svd(X[sel] - c0, full_matrices=False)[2][-1]
        return c0, nn, np.abs((X - c0) @ nn)

    def apply_plane(pix, c0, nn):
        r = raysf[pix]
        den = r @ nn
        rn = den / np.linalg.norm(r, axis=1)
        zmed = np.median(zf[pix])
        if np.median(np.abs(rn)) < 0.2:
            return np.full(len(pix), zmed)  # seen edge-on: stand it up facing the camera
        zs = (c0 @ nn) / np.where(np.abs(den) > 1e-9, den, np.nan)
        bad = ~np.isfinite(zs) | (zs <= 0.2) | (np.abs(zs - zf[pix]) > 0.35 * zf[pix])
        zs[bad] = zmed
        return zs

    def standing(pix, sub):
        """Vertical card facing the camera horizontally, at the robust depth of the pixels."""
        zmed = float(np.median(zf[sub]))
        cw = R @ (np.median(raysf[sub], 0) * zmed)  # centre, world offset from the camera
        nw = np.array([cw[0], 0.0, cw[2]])
        if np.linalg.norm(nw) < 1e-6:
            return np.full(len(pix), zmed)
        nw /= np.linalg.norm(nw)
        return apply_plane(pix, R.T @ cw, R.T @ nw)

    sp_pix = {}
    for s_ in np.flatnonzero(free):
        pix = order[bounds[s_]:bounds[s_ + 1]]
        sp_pix[s_] = pix[vf[pix]]
    groups = {}
    for s_ in sp_pix:
        groups.setdefault(obj[s_], []).append(s_)
    rng = np.random.default_rng(0)
    for members in groups.values():
        pix = np.concatenate([sp_pix[s_] for s_ in members])
        if len(pix) < 8:
            continue
        sub = pix if len(pix) <= 20000 else rng.choice(pix, 20000, replace=False)
        X = raysf[sub] * zf[sub, None]
        c0, nn, res = robust_plane(X)
        up_c = abs(float((R @ nn)[1]))
        if up_c > 0.85 and np.median(res) < 0.05 * np.median(zf[sub]) + 0.03:
            zf[pix] = apply_plane(pix, c0, nn)  # a horizontal surface: a step, a platform
            continue
        # anything else stands up, facing the camera: a post, a bin, a hedge, a tree. A
        # free-oriented plane through a thin or ragged object tilts at random and turns a
        # post into a diagonal bar; a standing card at the right distance does not.
        zf[pix] = standing(pix, sub)
        continue
        new = {}
        for s_ in members:
            q = sp_pix[s_]
            if len(q) < 8:
                continue
            c1, n1, _ = robust_plane(raysf[q] * zf[q, None])
            new[s_] = apply_plane(q, c1, n1)
        for s_, v in new.items():
            zf[sp_pix[s_]] = v
    z = zf.reshape(h, w)
    valid &= np.isfinite(z) & (z > 0.2) & (z < max_depth)
    z[~valid] = np.nan
    labels[~valid] = 0
    # mesh segments: one per object, one for the floor, one per wall
    seg = np.where(labels == 1, n + 1, np.where(labels >= 2, n + labels, obj[sp]))
    seg = np.where(valid, seg, -1)
    return z, labels, planes, seg, np.where(valid, sp, -1)


def drop_small_components(faces: np.ndarray, n_vertices: int, kind: np.ndarray, min_faces: int):
    """Mask of the faces to keep, without isolated bits of free surface (floaters): connected face groups too small to
    be a real object, unless they touch the ground."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    if len(faces) == 0:
        return np.ones(0, bool)
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [0, 2]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n_vertices, n_vertices))
    _, comp = connected_components(g, directed=False)
    fc = comp[faces[:, 0]]
    nface = np.bincount(fc)
    has_ground = np.bincount(fc, (kind[faces[:, 0]] == 1).astype(float), minlength=len(nface)) > 0
    return (nface[fc] >= min_faces) | has_ground[fc]
