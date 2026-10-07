"""Turn a track's observations into a description and a small gallery of saved views."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

import cv2
import numpy as np

from .appearance import COLOR_HEX, color_name, head_box, sharpness


def white_balance_gains(bg_bgr) -> np.ndarray:
    """Grey-world gains from the static background (removes a green/blue cast before naming colours)."""
    m = bg_bgr.reshape(-1, 3).astype(np.float64).mean(0)[::-1]  # RGB means
    return np.clip(m.mean() / np.maximum(m, 1), 0.7, 1.4)


def _vote(rgbs_weights):
    votes, members = Counter(), {}
    for rgb, wgt in rgbs_weights:
        if rgb is None:
            continue
        n = color_name(rgb)
        votes[n] += wgt
        members.setdefault(n, []).append(rgb)
    if not votes:
        return None
    name, score = votes.most_common(1)[0]
    total = sum(votes.values())
    rgb = np.median(np.array(members[name]), axis=0).astype(int).tolist()
    return {"name": name, "rgb": rgb, "swatch": COLOR_HEX[name], "agreement": round(score / total, 2)}


def describe_track(t, gains=None) -> dict:
    obs = [d for _, d in t.obs]
    w = [max(d["bbox"][3] - d["bbox"][1], 1) * d["conf"] for d in obs]
    g = np.ones(3) if gains is None else gains

    def wb(rgb):
        return None if rgb is None else tuple(int(v) for v in np.clip(np.array(rgb) * g, 0, 255))

    up = _vote([(wb(d.get("upper")), wi) for d, wi in zip(obs, w)])
    lo = _vote([(wb(d.get("lower")), wi) for d, wi in zip(obs, w)])
    out = {"upper": up, "lower": lo}
    if t.cls == "persona":
        parts = []
        if up:
            parts.append(f"sopra {up['name']}")
        if lo:
            parts.append(f"sotto {lo['name']}")
        out["text"] = ", ".join(parts)
    else:
        out["text"] = f"colore {up['name']}" if up else ""
    return out


def save_views(views, out_dir: Path, rel: str, face_det) -> list[dict]:
    """Save body and head crops at original resolution. Faces are searched in the head area."""
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for k, v in enumerate(views):
        body_p, head_p = out_dir / f"view{k}_body.jpg", out_dir / f"view{k}_head.png"
        cv2.imwrite(str(body_p), v["body"], [cv2.IMWRITE_JPEG_QUALITY, 95])
        cv2.imwrite(str(head_p), v["head"])  # PNG: no extra compression artefacts on tiny crops
        rec = {"frame": v["frame"], "t": round(v["t"], 3), "bbox": v["bbox"],
               "body": f"{rel}/{body_p.name}", "head": f"{rel}/{head_p.name}",
               "head_box": list(v["head_box"]), "head_px": int(v["head"].shape[0]),
               "head_sharpness": round(sharpness(v["head"]), 1), "face": None}
        f = face_det(v["head"]) if v["head"].shape[0] >= 16 else None
        if f is not None:
            hb = v["head_box"]
            rec["face"] = {"box": [hb[0] + f[0], hb[1] + f[1], hb[0] + f[2], hb[1] + f[3]],
                           "confidence": round(f[4], 3)}
        saved.append(rec)
    # best first: detected face, then bigger and sharper heads
    saved.sort(key=lambda r: (r["face"] is None, -r["head_px"] * (1 + r["head_sharpness"] / 400)))
    return saved
