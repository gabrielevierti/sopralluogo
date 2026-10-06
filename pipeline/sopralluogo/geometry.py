"""Camera geometry for a fixed camera looking at a ground plane.

Conventions
-----------
* Camera coordinates follow OpenCV: x right, y down, z forward.
* World coordinates are metric, Y-up, ground plane at y = 0, camera located
  at (0, h, 0) and looking roughly towards -Z (same as three.js).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def up_vector(pitch: float, roll: float) -> np.ndarray:
    """World 'up' direction expressed in camera coordinates.

    pitch > 0 means the camera is tilted down (radians); roll rotates around
    the optical axis.
    """
    v = np.array([0.0, -np.cos(pitch), -np.sin(pitch)])
    c, s = np.cos(roll), np.sin(roll)
    rz = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    return rz @ v


def intrinsics_from_hfov(width: int, height: int, hfov_deg: float) -> dict:
    fx = (width / 2.0) / np.tan(np.radians(hfov_deg) / 2.0)
    return {"fx": float(fx), "fy": float(fx), "cx": width / 2.0, "cy": height / 2.0,
            "width": int(width), "height": int(height)}


@dataclass
class CameraModel:
    K: dict
    pitch: float = 0.3
    roll: float = 0.0
    height: float = 4.0
    extra: dict = field(default_factory=dict)

    # ---------------------------------------------------------------- basics
    @property
    def up(self) -> np.ndarray:
        return up_vector(self.pitch, self.roll)

    @property
    def hfov_deg(self) -> float:
        return float(np.degrees(2 * np.arctan(self.K["width"] / 2 / self.K["fx"])))

    def rays(self, u, v) -> np.ndarray:
        """Unnormalised rays (z = 1) for pixel coordinates. Shape (..., 3)."""
        u = np.asarray(u, dtype=np.float64)
        v = np.asarray(v, dtype=np.float64)
        x = (u - self.K["cx"]) / self.K["fx"]
        y = (v - self.K["cy"]) / self.K["fy"]
        return np.stack([x, y, np.ones_like(x)], axis=-1)

    def project(self, X) -> np.ndarray:
        X = np.asarray(X, dtype=np.float64)
        z = X[..., 2]
        u = self.K["fx"] * X[..., 0] / z + self.K["cx"]
        v = self.K["fy"] * X[..., 1] / z + self.K["cy"]
        return np.stack([u, v], axis=-1)

    # ---------------------------------------------------------- ground plane
    def ground_point_cam(self, u, v):
        """Intersect pixel rays with the ground. Returns (points, valid)."""
        r = self.rays(u, v)
        denom = r @ self.up
        valid = denom < -1e-6  # ray must point below the horizon
        s = np.where(valid, -self.height / np.where(valid, denom, -1.0), np.nan)
        return r * s[..., None], valid

    def ground_depth(self, u, v):
        pts, valid = self.ground_point_cam(u, v)
        return pts[..., 2], valid

    def horizon_v(self, u: float | None = None) -> float:
        """Image row of the horizon at column u (default: image centre)."""
        if u is None:
            u = self.K["cx"]
        up = self.up
        # pixel ray r=(x,y,1) is horizontal when r.up = 0
        x = (u - self.K["cx"]) / self.K["fx"]
        y = -(up[0] * x + up[2]) / up[1]
        return float(y * self.K["fy"] + self.K["cy"])

    def object_height(self, foot_cam: np.ndarray, v_top) -> np.ndarray:
        """Height (m) of a vertical segment standing at foot_cam whose top projects to row v_top."""
        up = self.up
        m = (np.asarray(v_top) - self.K["cy"]) / self.K["fy"]
        Fy, Fz = foot_cam[..., 1], foot_cam[..., 2]
        return (Fy - m * Fz) / (m * up[2] - up[1])

    # ------------------------------------------------------------ transforms
    def world_from_cam(self) -> np.ndarray:
        """4x4 matrix mapping camera coords (OpenCV) to world (Y-up)."""
        up = self.up
        fwd = np.array([0.0, 0.0, 1.0])
        fwd_h = fwd - (fwd @ up) * up
        fwd_h /= np.linalg.norm(fwd_h)
        Y = up
        Z = -fwd_h
        X = np.cross(Y, Z)
        R = np.stack([X, Y, Z], axis=0)
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = [0.0, self.height, 0.0]
        return T

    def cam_to_world(self, X) -> np.ndarray:
        T = self.world_from_cam()
        X = np.asarray(X, dtype=np.float64)
        return X @ T[:3, :3].T + T[:3, 3]

    def to_json(self) -> dict:
        return {
            "K": self.K,
            "pitch_deg": float(np.degrees(self.pitch)),
            "roll_deg": float(np.degrees(self.roll)),
            "height_m": float(self.height),
            "hfov_deg": self.hfov_deg,
            "world_from_cam": self.world_from_cam().tolist(),
            **self.extra,
        }


def similarity_2d(src: np.ndarray, dst: np.ndarray, allow_scale: bool = True):
    """Umeyama: find s, R(2x2), t minimising |dst - (s R src + t)|. Returns (s, R, t, rms)."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[1, 1] = -1
    R = U @ D @ Vt
    var_s = (xs ** 2).sum() / len(src)
    s = float(np.trace(np.diag(S) @ D) / var_s) if allow_scale and var_s > 1e-12 else 1.0
    t = mu_d - s * R @ mu_s
    res = dst - (s * (src @ R.T) + t)
    rms = float(np.sqrt((res ** 2).sum(1).mean()))
    return s, R, t, rms


def ground_similarity_to_4x4(s: float, R2: np.ndarray, t2: np.ndarray) -> np.ndarray:
    """Embed a 2D similarity acting on world (x, z) into a 4x4 Y-up transform."""
    M = np.eye(4)
    M[0, 0], M[0, 2] = R2[0, 0] * s, R2[0, 1] * s
    M[2, 0], M[2, 2] = R2[1, 0] * s, R2[1, 1] * s
    M[1, 1] = s
    M[0, 3], M[2, 3] = t2[0], t2[1]
    return M
