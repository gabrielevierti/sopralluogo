"""What a subject looks like: clothing colours, a re-identification signature, best crops, faces.

Everything here is deliberately "classic" and explainable: colour histograms of the
torso and legs, measured only on pixels that differ from the static background (so the
pavement behind a person does not count). Crops are saved with the original pixels:
no AI enhancement or super-resolution, which would invent details that are not there.
"""
from __future__ import annotations

import heapq
import itertools

import cv2
import numpy as np

from .log import log

# --------------------------------------------------------------------------- colour names
COLOR_NAMES = ["nero", "grigio scuro", "grigio", "bianco", "rosso", "arancione", "giallo", "verde",
               "azzurro", "blu", "viola", "rosa", "marrone", "beige"]
COLOR_HEX = {"nero": "#1b1b1b", "grigio scuro": "#4a4a4a", "grigio": "#8c8c8c", "bianco": "#ececec",
             "rosso": "#c8312b", "arancione": "#e07b25", "giallo": "#e3c62f", "verde": "#3f8f45",
             "azzurro": "#5aa9df", "blu": "#2c4fa3", "viola": "#7b4ca8", "rosa": "#e07fb0",
             "marrone": "#6e4a2e", "beige": "#cdb88f"}


def color_name(rgb) -> str:
    """Name an RGB colour (0-255) with simple, explainable HSV rules."""
    px = np.uint8([[list(rgb)[::-1]]])
    h, s, v = cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0, 0].astype(float)
    h *= 2.0  # 0..360
    s /= 255.0
    v /= 255.0
    if v < 0.16:
        return "nero"
    if s < 0.18:
        if v < 0.38:
            return "grigio scuro"
        return "grigio" if v < 0.72 else "bianco"
    if 15 <= h < 45 and v < 0.55:
        return "marrone"
    if 20 <= h < 50 and s < 0.45 and v > 0.55:
        return "beige"
    if h < 15 or h >= 345:
        return "rosso" if v > 0.35 else "marrone"
    if h < 40:
        return "arancione" if v > 0.5 else "marrone"
    if h < 70:
        return "giallo"
    if h < 165:
        return "verde"
    if h < 200:
        return "azzurro"
    if h < 255:
        return "azzurro" if v > 0.75 and s < 0.5 else "blu"
    if h < 290:
        return "viola"
    return "rosa"


# --------------------------------------------------------------------------- features
def _region(bbox, top, bottom, width=0.6):
    x1, y1, x2, y2 = bbox
    h, w = y2 - y1, x2 - x1
    cx = (x1 + x2) / 2
    return (int(cx - w * width / 2), int(y1 + h * top), int(cx + w * width / 2), int(y1 + h * bottom))


def _fg_pixels(frame, bg, box):
    H, W = frame.shape[:2]
    x1, y1, x2, y2 = max(box[0], 0), max(box[1], 0), min(box[2], W), min(box[3], H)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return np.zeros((0, 3), np.uint8)
    f = frame[y1:y2, x1:x2]
    b = bg[y1:y2, x1:x2]
    diff = np.abs(f.astype(np.int16) - b.astype(np.int16)).sum(2)
    mask = diff > 40
    if mask.sum() < 0.15 * mask.size:  # person barely differs from background: use all pixels
        mask[:] = True
    return f[mask]


def _hist(pix_bgr):
    if len(pix_bgr) == 0:
        return np.zeros(18 * 3 + 4, np.float32)
    hsv = cv2.cvtColor(pix_bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)
    chroma = (hsv[:, 1] > 45) & (hsv[:, 2] > 50)
    hh = np.zeros(18 * 3, np.float32)
    if chroma.any():
        hi = np.minimum((hsv[chroma, 0] / 10).astype(int), 17)
        si = np.minimum((hsv[chroma, 1] / 86).astype(int), 2)
        np.add.at(hh, hi * 3 + si, 1)
    vv = np.zeros(4, np.float32)
    vi = np.minimum((hsv[~chroma, 2] / 64).astype(int), 3)
    np.add.at(vv, vi, 1)
    out = np.concatenate([hh, vv])
    return out / max(out.sum(), 1)


def _dominant(pix_bgr):
    if len(pix_bgr) < 8:
        return None
    data = pix_bgr.reshape(-1, 3).astype(np.float32)
    if len(data) > 1500:
        data = data[np.random.default_rng(0).choice(len(data), 1500, replace=False)]
    k = 3 if len(data) >= 30 else 1
    _, labels, centers = cv2.kmeans(data, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0),
                                    2, cv2.KMEANS_PP_CENTERS)
    c = centers[np.bincount(labels.ravel()).argmax()]
    return tuple(int(x) for x in c[::-1])  # RGB


def signature(frame, bg, bbox) -> dict:
    """Upper/lower body histograms (for matching) and dominant colours (for describing)."""
    up = _fg_pixels(frame, bg, _region(bbox, 0.18, 0.50))
    lo = _fg_pixels(frame, bg, _region(bbox, 0.55, 0.90, 0.5))
    return {"hist": np.concatenate([_hist(up), _hist(lo)]), "upper": _dominant(up), "lower": _dominant(lo)}


def hist_distance(a, b) -> float:
    """Bhattacharyya distance (0 = identical, 1 = nothing in common), averaged over the two halves."""
    n = len(a) // 2
    d = 0.0
    for s in (slice(0, n), slice(n, None)):
        x, y = a[s], b[s]
        if x.sum() == 0 or y.sum() == 0:
            d += 0.5
            continue
        d += float(np.sqrt(max(0.0, 1.0 - np.sum(np.sqrt(x * y)))))
    return d / 2


# --------------------------------------------------------------------------- faces
class FaceDetector:
    """OpenCV's res10 SSD face detector. Optional: if the model is missing faces are skipped."""

    def __init__(self):
        from .models import ensure_model
        try:
            proto, weights = ensure_model("face_proto"), ensure_model("face")
            self.net = cv2.dnn.readNetFromCaffe(str(proto), str(weights))
        except Exception as e:  # pragma: no cover - offline without the model
            log(f"Rilevatore di volti non disponibile ({e}): salto i volti")
            self.net = None

    def __call__(self, crop):
        """Best face in a head-region crop: (x1, y1, x2, y2, confidence) in crop pixels, or None."""
        if self.net is None or crop.size == 0:
            return None
        h, w = crop.shape[:2]
        blob = cv2.dnn.blobFromImage(cv2.resize(crop, (300, 300), interpolation=cv2.INTER_CUBIC), 1.0,
                                     (300, 300), (104.0, 177.0, 123.0))
        self.net.setInput(blob)
        det = self.net.forward()[0, 0]
        best = None
        for d in det:
            conf = float(d[2])
            if conf < 0.7:  # tiny faces: only confident detections, no false "volto rilevato"
                continue
            x1, y1, x2, y2 = d[3] * w, d[4] * h, d[5] * w, d[6] * h
            if best is None or conf > best[4]:
                best = (x1, y1, x2, y2, conf)
        return best


def head_box(bbox, frame_shape):
    """Generous head region from a person box: top ~22% of the height, square."""
    x1, y1, x2, y2 = bbox
    h = y2 - y1
    side = max(h * 0.24, 8)
    cx = (x1 + x2) / 2
    top = y1 - 0.03 * h
    H, W = frame_shape[:2]
    return (int(max(cx - side / 2, 0)), int(max(top, 0)), int(min(cx + side / 2, W)), int(min(top + side, H)))


def sharpness(img) -> float:
    if img.size == 0:
        return 0.0
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


class CropKeeper:
    """Keeps the K best views of each tracklet, in memory, while the video streams by."""

    def __init__(self, k: int = 4):
        self.k = k
        self.heaps: dict[int, list] = {}
        self._tie = itertools.count()

    def offer(self, tid: int, frame_idx: int, t: float, frame, bbox, conf: float, uid: int = -1):
        H, W = frame.shape[:2]
        x1, y1, x2, y2 = bbox
        bh = y2 - y1
        if bh < 20:
            return
        border = x1 < 2 or y1 < 2 or x2 > W - 2 or y2 > H - 2
        hb = head_box(bbox, frame.shape)
        head = frame[hb[1]:hb[3], hb[0]:hb[2]]
        score = bh * conf * (0.4 if border else 1.0) * (1 + min(sharpness(head), 400) / 400)
        heap = self.heaps.setdefault(tid, [])
        if len(heap) >= self.k and score <= heap[0][0]:
            return
        pad = 0.08 * bh
        bx = (int(max(x1 - pad, 0)), int(max(y1 - pad, 0)), int(min(x2 + pad, W)), int(min(y2 + pad, H)))
        item = (score, next(self._tie), {"uid": uid, "frame": frame_idx, "t": t, "bbox": [float(v) for v in bbox],
                                         "body": frame[bx[1]:bx[3], bx[0]:bx[2]].copy(), "body_box": bx,
                                         "head": head.copy(), "head_box": hb})
        if len(heap) < self.k:
            heapq.heappush(heap, item)
        else:
            heapq.heapreplace(heap, item)

    def best(self, tids, uids=None, k=None):
        items = [it for tid in tids for it in self.heaps.get(tid, []) if uids is None or it[2]["uid"] in uids]
        items.sort(key=lambda x: -x[0])
        return [it[2] | {"score": it[0]} for it in items[: k or self.k]]
