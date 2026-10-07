"""Silhouette atlas: one small mask per track sample, packed into a single PNG for the viewer."""
from __future__ import annotations

import cv2
import numpy as np

from .nets import Segmenter

COLS = 64


def write_mask_atlas(trajs: list[dict], tracks_by_id: dict, stride: int, path) -> dict | None:
    cw, ch = Segmenter.CELL
    cells = []
    for tr in trajs:
        obs = tracks_by_id[tr["id"]].obs
        fr = np.array([f for f, d in obs if d.get("mask") is not None])
        ms = [d["mask"] for f, d in obs if d.get("mask") is not None]
        idx = []
        for f in tr["frame"]:
            if len(fr) == 0:
                idx.append(-1)
                continue
            k = int(np.argmin(np.abs(fr - f)))
            if abs(fr[k] - f) <= 2 * stride:
                idx.append(len(cells))
                cells.append(ms[k])
            else:
                idx.append(-1)
        tr["mask"] = idx
    if not cells:
        return None
    rows = (len(cells) + COLS - 1) // COLS
    atlas = np.zeros((rows * ch, COLS * cw), np.uint8)
    for i, m in enumerate(cells):
        r, c = divmod(i, COLS)
        atlas[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = m
    cv2.imwrite(str(path), atlas)
    return {"cols": COLS, "cell": [cw, ch], "count": len(cells), "size": [atlas.shape[1], atlas.shape[0]]}
