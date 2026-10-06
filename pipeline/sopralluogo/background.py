"""Static background plate (moving people removed) and camera-motion check."""
from __future__ import annotations

import cv2
import numpy as np


def median_background(frames: list[np.ndarray]) -> np.ndarray:
    """Per-pixel temporal median: anything that moves disappears, the static scene remains."""
    stack = np.stack(frames, axis=0)
    return np.median(stack, axis=0).astype(np.uint8)


def camera_motion(frames: list[np.ndarray]) -> dict:
    """Estimate how much the camera itself moves (pan/shake) between sampled frames.

    Returns the median background displacement in pixels. A fixed camera is ~0;
    anything above a few pixels means the single-view model is not reliable.
    """
    if len(frames) < 2:
        return {"median_px": 0.0, "max_px": 0.0, "static": True}
    g0 = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    p0 = cv2.goodFeaturesToTrack(g0, maxCorners=400, qualityLevel=0.01, minDistance=12)
    if p0 is None:
        return {"median_px": 0.0, "max_px": 0.0, "static": True}
    shifts = []
    for f in frames[1:]:
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(g0, g, p0, None)
        ok = st.ravel() == 1
        if ok.sum() < 10:
            shifts.append(99.0)
            continue
        d = np.linalg.norm((p1 - p0).reshape(-1, 2)[ok], axis=1)
        shifts.append(float(np.median(d)))  # median ignores moving people
    med, mx = float(np.median(shifts)), float(np.max(shifts))
    return {"median_px": med, "max_px": mx, "static": mx < 3.0}
