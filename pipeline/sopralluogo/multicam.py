"""Putting several videos of the same event on one clock and one map.

Time:  audio cross-correlation (same sounds heard by both cameras), or manual offsets.
Space: every camera is already metric and gravity-aligned (Y up, floor at 0), so
       only a rotation about the vertical, a ground translation and a small scale
       correction are missing. They are found either from people that both cameras
       see at the same time (automatic) or from >= 2 landmark pairs picked by the user.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

from .geometry import ground_similarity_to_4x4, similarity_2d
from .log import log

AUDIO_RATE = 4000


def _audio_envelope(path: Path, max_s: float = 600) -> np.ndarray | None:
    try:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-t", str(max_s), "-vn", "-ac", "1",
                              "-ar", str(AUDIO_RATE), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        return None
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if len(x) < AUDIO_RATE:
        return None
    # onset strength: positive changes of a short-window energy envelope
    hop = AUDIO_RATE // 100
    n = len(x) // hop
    env = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-9)
    env = np.log(env)
    onset = np.clip(np.diff(env, prepend=env[0]), 0, None)
    return (onset - onset.mean()) / (onset.std() + 1e-9)


def audio_offset(ref: Path, other: Path) -> tuple[float, float] | None:
    """Seconds to ADD to `other`'s local time to get `ref`'s time, and a confidence score."""
    a, b = _audio_envelope(ref), _audio_envelope(other)
    if a is None or b is None:
        return None
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    xc = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    xc = np.concatenate([xc[-(len(b) - 1):], xc[: len(a)]])
    lags = np.arange(-(len(b) - 1), len(a))
    k = int(np.argmax(xc))
    peak = xc[k]
    mask = np.abs(lags - lags[k]) > 50  # exclude +-0.5 s around the peak
    conf = float(peak / (np.max(xc[mask]) + 1e-9)) if mask.any() else 0.0
    return float(lags[k] / 100.0), conf


def _sample(track: dict, times: np.ndarray, offset: float) -> np.ndarray:
    t = np.asarray(track["t"]) + offset
    p = np.asarray(track["p"])
    return np.stack([np.interp(times, t, p[:, 0]), np.interp(times, t, p[:, 1])], 1)


def align_by_tracks(ref_tracks: list[dict], tracks: list[dict], offset_ref: float, offset: float,
                    min_overlap_s: float = 2.0):
    """Hypothesise 'track A (ref) == track B (other)', fit a similarity, keep the best-supported one."""
    cands = []
    for A in ref_tracks:
        for B in tracks:
            if A["cls"] != B["cls"]:
                continue
            t0 = max(A["t"][0] + offset_ref, B["t"][0] + offset)
            t1 = min(A["t"][-1] + offset_ref, B["t"][-1] + offset)
            if t1 - t0 < min_overlap_s:
                continue
            times = np.linspace(t0, t1, 20)
            pa, pb = _sample(A, times, offset_ref), _sample(B, times, offset)
            if np.linalg.norm(pa[-1] - pa[0]) < 1.0:  # needs movement to constrain rotation
                continue
            s, R, tt, rms = similarity_2d(pb, pa)
            if not 0.7 < s < 1.4:
                continue
            cands.append((s, R, tt, rms, A["id"], B["id"]))
    if not cands:
        return None
    best, best_support = None, -1.0
    for s, R, tt, rms, _, _ in cands:
        support = 0.0
        for s2, R2, t2, rms2, _, _ in cands:
            ang = np.arctan2(R[1, 0], R[0, 0]) - np.arctan2(R2[1, 0], R2[0, 0])
            if abs((ang + np.pi) % (2 * np.pi) - np.pi) < np.radians(10) and np.linalg.norm(tt - t2) < 2.0:
                support += 1.0 / (1.0 + rms2)
        if support > best_support:
            best, best_support = (s, R, tt, rms), support
    s, R, tt, rms = best
    log(f"Allineamento automatico da tracce: scala {s:.3f}, rotazione "
        f"{np.degrees(np.arctan2(R[1, 0], R[0, 0])):.1f} deg, rms {rms:.2f} m")
    return ground_similarity_to_4x4(s, R, tt), {"method": "tracce condivise", "rms_m": rms, "scale": s,
                                                "hypotheses": len(cands)}


def align_by_points(pairs: list[dict]):
    """pairs: [{"src": [x, z], "dst": [x, z]}, ...] with src in the camera's frame, dst in the reference."""
    src = np.array([p["src"] for p in pairs], dtype=float)
    dst = np.array([p["dst"] for p in pairs], dtype=float)
    if len(src) < 2:
        raise SystemExit("Servono almeno 2 coppie di punti per allineare una camera.")
    s, R, t, rms = similarity_2d(src, dst, allow_scale=len(src) >= 3)
    return ground_similarity_to_4x4(s, R, t), {"method": "punti di riferimento", "rms_m": rms, "scale": s,
                                               "pairs": len(src)}
