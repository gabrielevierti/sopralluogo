"""Video ingest: metadata, hashing, frame access and browser-friendly proxy."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .log import log
from .models import sha256_file


def require_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise SystemExit(f"'{tool}' non trovato: installa FFmpeg (https://ffmpeg.org) e riprova.")


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    num, den = (int(x) for x in v.get("avg_frame_rate", "0/1").split("/"))
    fps = num / den if den and num else 25.0
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    return {
        "width": int(v["width"]), "height": int(v["height"]), "fps": fps,
        "duration": float(info["format"].get("duration", v.get("duration", 0)) or 0),
        "codec": v.get("codec_name"), "has_audio": any(s["codec_type"] == "audio" for s in info["streams"]),
        "rotation": rotation,
        "creation_time": info["format"].get("tags", {}).get("creation_time"),
    }


def evidence_record(path: Path) -> dict:
    """Identity of an original file. The original is never modified."""
    st = path.stat()
    return {"original_path": str(path.resolve()), "file_name": path.name, "size_bytes": st.st_size,
            "sha256": sha256_file(path)}


def make_proxy(src: Path, dst: Path) -> None:
    """H.264 copy with dense keyframes so the viewer can scrub frame-accurately."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    log(f"Creo copia di consultazione {dst.name} (l'originale resta intatto)")
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(src),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-g", "10", "-keyint_min", "1", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "128k", str(dst)], check=True)


class FrameReader:
    def __init__(self, path: Path):
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise SystemExit(f"Impossibile aprire il video {path}")
        self.n = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0

    def iterate(self, stride: int = 1):
        """Yield (frame_index, timestamp_s, bgr) for every `stride`-th frame."""
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        i = 0
        while True:
            ok = self.cap.grab()
            if not ok:
                break
            if i % stride == 0:
                ok, frame = self.cap.retrieve()
                if not ok:
                    break
                ts = self.cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if ts <= 0 and i > 0:
                    ts = i / self.fps
                yield i, i / self.fps, frame
            i += 1

    def sample(self, count: int) -> list[np.ndarray]:
        idx = np.linspace(0, max(self.n - 1, 0), num=min(count, max(self.n, 1))).astype(int)
        frames = []
        for k in idx:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, int(k))
            ok, f = self.cap.read()
            if ok:
                frames.append(f)
        return frames

    def close(self):
        self.cap.release()
