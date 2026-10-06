"""Neural networks: monocular depth (Depth Anything V2) and object detection (YOLO11)."""
from __future__ import annotations

import cv2
import numpy as np

from .models import session

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# COCO ids we care about -> label used in the case file
CLASSES = {0: "persona", 1: "bicicletta", 2: "auto", 3: "moto", 5: "autobus", 7: "camion"}


class DepthNet:
    """Relative inverse depth ("disparity"), up to an unknown affine transform."""

    def __init__(self, size: int = 518):
        self.sess = session("depth")
        self.size = size

    def __call__(self, bgr: np.ndarray) -> np.ndarray:
        h, w = bgr.shape[:2]
        scale = self.size / min(h, w)
        nh = max(14, int(round(h * scale / 14)) * 14)
        nw = max(14, int(round(w * scale / 14)) * 14)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        x = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255.0
        x = (x - IMAGENET_MEAN) / IMAGENET_STD
        x = x.transpose(2, 0, 1)[None]
        d = self.sess.run(None, {self.sess.get_inputs()[0].name: x})[0][0]
        return cv2.resize(d.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)


class Detector:
    def __init__(self, imgsz: int = 960, conf: float = 0.30, iou: float = 0.5):
        self.sess = session("detector")
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou

    def __call__(self, bgr: np.ndarray) -> list[dict]:
        h, w = bgr.shape[:2]
        r = self.imgsz / max(h, w)
        nh, nw = int(round(h * r)), int(round(w * r))
        canvas = np.full((self.imgsz, self.imgsz, 3), 114, dtype=np.uint8)
        top, left = (self.imgsz - nh) // 2, (self.imgsz - nw) // 2
        canvas[top:top + nh, left:left + nw] = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        out = self.sess.run(None, {self.sess.get_inputs()[0].name: x})[0][0].T  # (anchors, 84)
        boxes, scores = out[:, :4], out[:, 4:]
        cls = scores.argmax(1)
        conf = scores[np.arange(len(cls)), cls]
        keep = (conf >= self.conf) & np.isin(cls, list(CLASSES))
        boxes, cls, conf = boxes[keep], cls[keep], conf[keep]
        if len(boxes) == 0:
            return []
        cx, cy, bw, bh = boxes.T
        x1 = (cx - bw / 2 - left) / r
        y1 = (cy - bh / 2 - top) / r
        x2 = (cx + bw / 2 - left) / r
        y2 = (cy + bh / 2 - top) / r
        xyxy = np.stack([x1, y1, x2, y2], 1).clip([0, 0, 0, 0], [w, h, w, h])
        dets = []
        for c in np.unique(cls):
            m = np.where(cls == c)[0]
            xywh = [[float(a), float(b), float(c2 - a), float(d - b)] for a, b, c2, d in xyxy[m]]
            idx = cv2.dnn.NMSBoxes(xywh, conf[m].tolist(), self.conf, self.iou)
            for k in np.array(idx).reshape(-1):
                j = m[k]
                dets.append({"bbox": xyxy[j].tolist(), "conf": float(conf[j]), "cls": CLASSES[int(c)]})
        return dets
