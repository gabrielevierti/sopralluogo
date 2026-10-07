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
        self.feat = None
        self.add(det, frame)

    def add(self, det: dict, frame: int):
        box = np.array(det["bbox"], dtype=float)
        if self.obs:
            dt = max(frame - self.last_frame, 1)
            self.vel = 0.6 * self.vel + 0.4 * (box - self.last_box) / dt
        self.last_box, self.last_frame = box, frame
        self.cls_votes[det["cls"]] = self.cls_votes.get(det["cls"], 0) + det["conf"]
        f = det.get("feat")
        if f is not None and f.sum() > 0:
            self.feat = f.copy() if self.feat is None else 0.85 * self.feat + 0.15 * f
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
            # appearance: two people crossing swap boxes, they do not swap clothes
            from .appearance import hist_distance
            for i, t in enumerate(self.active):
                for j, d in enumerate(dets):
                    if _group(d["cls"]) != t.group:
                        cost[i, j] = 1.0
                        continue
                    if t.feat is not None and d.get("feat") is not None and cost[i, j] < 1.0:
                        a = hist_distance(t.feat, d["feat"])
                        if a > 0.55:
                            cost[i, j] = 1.0
                        else:
                            cost[i, j] = 0.65 * cost[i, j] + 0.35 * a
            rows, cols = linear_sum_assignment(cost)
            for r, c in zip(rows, cols):
                if cost[r, c] < 1.0 - self.iou_gate:
                    self.active[r].add(dets[c], frame)
                    dets[c]["_tid"] = self.active[r].id
                    matched_d.add(c)
        for j, d in enumerate(dets):
            if j not in matched_d:
                self.active.append(_Track(self.next_id, d, frame))
                d["_tid"] = self.next_id
                self.next_id += 1
        alive = []
        for t in self.active:
            (alive if frame - t.last_frame <= self.max_gap else self.done).append(t)
        self.active = alive

    def finish(self) -> list[_Track]:
        """Confirmed tracklets. Each keeps `raw_ids` (ids used during tracking, for crop lookup)."""
        tracks = [t for t in self.done + self.active if len(t.obs) >= self.min_hits]
        for t in tracks:
            t.raw_ids = [t.id]
            t.links = []
        tracks.sort(key=lambda t: t.obs[0][0])
        return tracks


def renumber(tracks):
    tracks.sort(key=lambda t: t.obs[0][0])
    for i, t in enumerate(tracks, start=1):  # compact, readable ids: 1, 2, 3...
        t.id = i
    return tracks


def _end_state(t, first: bool, fps: float):
    """Position (m) at the start/end of a tracklet and the velocity there (m/s), from ~1 s of samples."""
    obs = t.obs[: max(3, int(fps // 3))] if first else t.obs[-max(3, int(fps // 3)):]
    pts = [(f, d["xz"]) for f, d in obs if d.get("xz") is not None]
    if not pts:
        return None, np.zeros(2)
    fr = np.array([f for f, _ in pts], float) / fps
    xz = np.array([p for _, p in pts], float)
    pos = xz[0] if first else xz[-1]
    if len(pts) >= 2 and fr[-1] > fr[0]:
        vel = (xz[-1] - xz[0]) / (fr[-1] - fr[0])
    else:
        vel = np.zeros(2)
    return pos, vel


def link_tracklets(tracks, cam, fps: float, max_gap_s: float = 4.0, max_app: float = 0.40):
    """Re-identification across occlusions (a pole, a parked van, another person).

    A tracklet that ends and one that starts shortly after are joined when
      * the second one appears where the first one would be if it had kept walking
        (constant-velocity prediction, tolerance growing with the time hidden), and
      * the clothes match.
    Each candidate pair is scored and the best pairs win, one-to-one.
    """
    from .appearance import hist_distance

    ends = {id(t): _end_state(t, False, fps) for t in tracks}
    starts = {id(t): _end_state(t, True, fps) for t in tracks}
    cands = []
    for a in tracks:
        a_end, a_vel = ends[id(a)]
        for b in tracks:
            if a is b or b.obs[0][0] <= a.obs[-1][0] or a.group != b.group or a.feat is None or b.feat is None:
                continue
            gap = (b.obs[0][0] - a.obs[-1][0]) / fps
            b_start, _ = starts[id(b)]
            if gap > max_gap_s or a_end is None or b_start is None:
                continue
            vmax = 3.0 if a.group == "persona" else 30.0
            allowed = (1.5 + 0.7 * gap) if a.group == "persona" else (3.0 + 5.0 * gap)
            app_limit = max_app
            if (a.obs[-1][0] - a.obs[0][0]) / fps < 1.0:
                # very short fragment (often half hidden): its speed is noise, its colours are mixed
                v = np.zeros(2)
                allowed *= 1.3
                app_limit = 0.5
            else:
                sp = np.linalg.norm(a_vel)
                v = a_vel * min(1.0, vmax / sp) if sp > 0 else a_vel
            resid = float(np.linalg.norm(a_end + v * gap - b_start))
            app = hist_distance(a.feat, b.feat)
            ok = (resid <= allowed and app <= app_limit) or (resid <= 2 * allowed and app <= 0.25)
            if not ok:
                continue
            cands.append((app + 0.1 * resid / allowed, a, b, gap, app, resid))
    cands.sort(key=lambda c: c[0])
    nxt, prv = {}, {}
    for _, a, b, gap, app, resid in cands:
        if id(a) in nxt or id(b) in prv:
            continue
        nxt[id(a)], prv[id(b)] = (b, gap, app, resid), a
    merged = []
    for t in tracks:
        if id(t) in prv:
            continue  # will be absorbed by its predecessor
        cur = t
        while id(cur) in nxt:
            b, gap, app, resid = nxt[id(cur)]
            t.links.append({"after_frame": cur.obs[-1][0], "before_frame": b.obs[0][0], "gap_s": round(gap, 2),
                            "appearance_distance": round(app, 3), "position_error_m": round(resid, 2)})
            t.obs.extend(b.obs)
            t.raw_ids.extend(b.raw_ids)
            for k, v in b.cls_votes.items():
                t.cls_votes[k] = t.cls_votes.get(k, 0) + v
            t.feat = (t.feat + b.feat) / 2
            cur = b
        merged.append(t)
    return merged


class WorldTracker:
    """Second-pass tracker that works on the ground plane, in metres.

    Once the camera is calibrated, every detection has a position on the floor and an
    uncertainty. Two people walking side by side are 60 cm apart in reality even when
    their boxes overlap on screen; a person hidden behind a pole keeps walking at the
    same speed. Association therefore combines:
      * physical distance between the predicted and the observed position (gated by
        a maximum plausible displacement that grows with the time hidden),
      * overlap of the boxes on screen,
      * clothing similarity, weighted more when people are crowded together.
    """

    def __init__(self, cam, fps: float, max_gap_frames: int, min_hits: int = 4):
        self.cam = cam
        self.fps = fps
        self.max_gap = max_gap_frames
        self.min_hits = min_hits
        self.active: list[_Track] = []
        self.done: list[_Track] = []
        self.next_id = 1

    def _world(self, dets):
        from .calibrate import ground_sigma
        if not dets:
            return
        b = np.array([d["bbox"] for d in dets], dtype=float)
        u, v = (b[:, 0] + b[:, 2]) / 2, b[:, 3]
        P, ok = self.cam.ground_point_cam(u, v)
        W = self.cam.cam_to_world(np.where(ok[:, None], P, 0))
        sig = ground_sigma(self.cam, u, v, b[:, 3] - b[:, 1])
        ov = iou(b, b)
        np.fill_diagonal(ov, 0)
        for k, d in enumerate(dets):
            d["xz"] = W[k, [0, 2]] if ok[k] else None
            d["sigma"] = float(sig[k]) if np.isfinite(sig[k]) else 1.0
            d["crowded"] = bool((ov[k] > 0.05).any())

    @staticmethod
    def _new(tid, d, frame):
        t = _Track(tid, d, frame)
        t.pos = None if d["xz"] is None else np.array(d["xz"], float)
        t.vel = np.zeros(2)
        t.box_vel = np.zeros(4)
        t.last_box = np.array(d["bbox"], float)
        if d.get("crowded"):
            t.feat = None if d.get("feat") is None else d["feat"].copy()
        return t

    def update(self, frame: int, dets: list[dict]):
        from .appearance import hist_distance
        self._world(dets)
        n_t, n_d = len(self.active), len(dets)
        if n_t and n_d:
            cost = np.ones((n_t, n_d))
            boxes = np.array([d["bbox"] for d in dets], float)
            for i, t in enumerate(self.active):
                dt = (frame - t.last_frame) / self.fps
                pred_box = t.last_box + t.box_vel * (frame - t.last_frame)
                ious = iou(pred_box[None], boxes)[0]
                vmax = 3.0 if t.group == "persona" else 30.0
                for j, d in enumerate(dets):
                    if _group(d["cls"]) != t.group:
                        continue
                    if t.pos is not None and d["xz"] is not None:
                        pred = t.pos + t.vel * dt
                        dist = float(np.linalg.norm(pred - d["xz"]))
                        gate = 0.6 + vmax * 0.5 * dt + 2.0 * d["sigma"]
                        if dist > gate:
                            continue
                        c_m = dist / gate
                        c_m = 0.5 * c_m + 0.5 * (1 - ious[j]) if ious[j] > 0 else c_m
                    elif ious[j] > 0.1:
                        c_m = 1 - ious[j]
                    else:
                        continue
                    if t.feat is not None and d.get("feat") is not None:
                        a = hist_distance(t.feat, d["feat"])
                        if a > 0.5:
                            continue
                        wa = 0.6 if d["crowded"] else 0.35
                        cost[i, j] = (1 - wa) * c_m + wa * a
                    else:
                        cost[i, j] = c_m
            rows, cols = linear_sum_assignment(cost)
            matched = set()
            for r, c in zip(rows, cols):
                if cost[r, c] < 0.8:
                    self._add(self.active[r], dets[c], frame)
                    matched.add(c)
        else:
            matched = set()
        for j, d in enumerate(dets):
            if j not in matched:
                t = self._new(self.next_id, d, frame)
                d["_tid"] = self.next_id
                self.active.append(t)
                self.next_id += 1
        alive = []
        for t in self.active:
            (alive if frame - t.last_frame <= self.max_gap else self.done).append(t)
        self.active = alive

    def _add(self, t, d, frame):
        dtf = max(frame - t.last_frame, 1)
        box = np.array(d["bbox"], float)
        t.box_vel = 0.6 * t.box_vel + 0.4 * (box - t.last_box) / dtf
        t.last_box = box
        if d["xz"] is not None:
            xz = np.array(d["xz"], float)
            if t.pos is not None:
                v = (xz - t.pos) / (dtf / self.fps)
                vmax = 3.0 if t.group == "persona" else 30.0
                sp = np.linalg.norm(v)
                if sp > vmax:
                    v *= vmax / sp
                t.vel = 0.7 * t.vel + 0.3 * v
            t.pos = xz
        t.last_frame = frame
        t.cls_votes[d["cls"]] = t.cls_votes.get(d["cls"], 0) + d["conf"]
        f = d.get("feat")
        if f is not None and f.sum() > 0 and not d["crowded"]:  # overlapping boxes mix two people's colours
            t.feat = f.copy() if t.feat is None else 0.85 * t.feat + 0.15 * f
        t.obs.append((frame, d))
        d["_tid"] = t.id

    def finish(self):
        tracks = [t for t in self.done + self.active if len(t.obs) >= self.min_hits]
        for t in tracks:
            t.raw_ids = [t.id]
            t.links = []
        tracks.sort(key=lambda t: t.obs[0][0])
        return tracks
