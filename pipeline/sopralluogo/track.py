"""Lightweight multi-object tracker: constant-velocity prediction + Hungarian matching on IoU."""
from __future__ import annotations

import numpy as np
from scipy.optimize import linear_sum_assignment

PERSON_LIKE = {"persona"}


def iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise IoU between (N,4) and (M,4) xyxy boxes."""
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    bb = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (aa[:, None] + bb[None, :] - inter + 1e-9)


def _group(cls: str) -> str:
    return "persona" if cls in PERSON_LIKE else "veicolo"


class _Track:
    def __init__(self, tid: int, det: dict, frame: int):
        self.id = tid
        self.cls_votes: dict[str, float] = {}
        self.obs: list[tuple[int, dict]] = []
        self.vel = np.zeros(4)
        self.last_box = np.array(det["bbox"], dtype=float)
        self.last_frame = frame
        self.group = _group(det["cls"])
        self.add(det, frame)

    def add(self, det: dict, frame: int):
        box = np.array(det["bbox"], dtype=float)
        if self.obs:
            dt = max(frame - self.last_frame, 1)
            self.vel = 0.6 * self.vel + 0.4 * (box - self.last_box) / dt
        self.last_box, self.last_frame = box, frame
        self.cls_votes[det["cls"]] = self.cls_votes.get(det["cls"], 0) + det["conf"]
        self.obs.append((frame, det))

    def predict(self, frame: int) -> np.ndarray:
        return self.last_box + self.vel * (frame - self.last_frame)

    @property
    def cls(self) -> str:
        return max(self.cls_votes, key=self.cls_votes.get)


class Tracker:
    def __init__(self, max_gap_frames: int, min_hits: int = 4, iou_gate: float = 0.15):
        self.max_gap = max_gap_frames
        self.min_hits = min_hits
        self.iou_gate = iou_gate
        self.active: list[_Track] = []
        self.done: list[_Track] = []
        self.next_id = 1

    def update(self, frame: int, dets: list[dict]):
        boxes = np.array([d["bbox"] for d in dets], dtype=float).reshape(-1, 4)
        matched_d = set()
        if self.active and len(dets):
            pred = np.stack([t.predict(frame) for t in self.active])
            cost = 1.0 - iou(pred, boxes)
            # centre-distance fallback for small, fast-moving boxes
            pc = (pred[:, :2] + pred[:, 2:]) / 2
            dc = (boxes[:, :2] + boxes[:, 2:]) / 2
            ph = np.maximum(pred[:, 3] - pred[:, 1], 1)
            dist = np.linalg.norm(pc[:, None] - dc[None], axis=2) / ph[:, None]
            cost = np.minimum(cost, np.where(dist < 0.6, 0.5 + dist / 2, 1.0))
            for i, t in enumerate(self.active):
                for j, d in enumerate(dets):
                    if _group(d["cls"]) != t.group:
                        cost[i, j] = 1.0
            rows, cols = linear_sum_assignment(cost)
            for r, c in zip(rows, cols):
                if cost[r, c] < 1.0 - self.iou_gate:
                    self.active[r].add(dets[c], frame)
                    matched_d.add(c)
        for j, d in enumerate(dets):
            if j not in matched_d:
                self.active.append(_Track(self.next_id, d, frame))
                self.next_id += 1
        alive = []
        for t in self.active:
            (alive if frame - t.last_frame <= self.max_gap else self.done).append(t)
        self.active = alive

    def finish(self) -> list[_Track]:
        tracks = [t for t in self.done + self.active if len(t.obs) >= self.min_hits]
        tracks.sort(key=lambda t: t.obs[0][0])
        for i, t in enumerate(tracks, start=1):  # compact, readable ids: 1, 2, 3...
            t.id = i
        return tracks
