"""Neural network weights: downloaded once, cached, verified, run with ONNX Runtime (CPU or GPU)."""
from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path

from .log import log

MODELS = {
    "depth": {
        "file": "depth_anything_v2_vits_dynamic.onnx",
        "url": "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/"
               "depth_anything_v2_vits_dynamic.onnx",
        "about": "Depth Anything V2 Small (Apache-2.0) - stima di profondita' relativa da singola immagine",
    },
    "detector": {
        "file": "yolo11n.onnx",
        "url": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx",
        "about": "YOLO11n (AGPL-3.0, Ultralytics) - rilevamento persone e veicoli",
    },
}


def models_dir() -> Path:
    d = Path(os.environ.get("SOPRALLUOGO_MODELS", Path.home() / ".cache" / "sopralluogo" / "models"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def ensure_model(key: str) -> Path:
    spec = MODELS[key]
    path = models_dir() / spec["file"]
    if not path.exists():
        log(f"Scarico il modello {spec['file']} ...")
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(spec["url"], tmp)
        tmp.rename(path)
    return path


def session(key: str):
    import onnxruntime as ort

    path = ensure_model(key)
    providers = [p for p in ("CUDAExecutionProvider", "CoreMLExecutionProvider", "CPUExecutionProvider")
                 if p in ort.get_available_providers()]
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(str(path), sess_options=opts, providers=providers)


def model_info(key: str) -> dict:
    path = ensure_model(key)
    return {"file": path.name, "sha256": sha256_file(path), "source": MODELS[key]["url"],
            "about": MODELS[key]["about"]}
