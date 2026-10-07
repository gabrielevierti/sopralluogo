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
        "sha256": "46c4e8eeda3a27f34701831b6a2ec7753d7b38779b215acb5633424703deed8f",
        "url": "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/"
               "depth_anything_v2_vits_dynamic.onnx",
        "about": "Depth Anything V2 Small (Apache-2.0) - stima di profondita' relativa da singola immagine",
    },
    "detector": {
        "file": "yolo11n.onnx",
        "sha256": "634279b40c07c6391472c51ad45b81ebc48706a9a1fe72dd3396322acd0c053b",
        "url": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx",
        "about": "YOLO11n (AGPL-3.0, Ultralytics) - rilevamento persone e veicoli",
    },
    "segmenter": {
        "file": "yolo11n-seg.onnx",
        "sha256": "0bc32bc92e985b881141ef9bd2216e2a746f70519d0d24da9fc85decc4428cf4",
        "url": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-seg.onnx",
        "about": "YOLO11n-seg (AGPL-3.0, Ultralytics) - sagome delle persone (rotoscoping)",
    },
    "face": {
        "file": "res10_300x300_ssd_iter_140000.caffemodel",
        "sha256": "2a56a11a57a4a295956b0660b4a3d76bbdca2206c4961cea8efe7d95c7cb2f2d",
        "url": "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/"
               "res10_300x300_ssd_iter_140000.caffemodel",
        "about": "OpenCV res10 SSD (BSD) - rilevamento volti",
    },
    "face_proto": {
        "file": "res10_deploy.prototxt",
        "sha256": "dcd661dc48fc9de0a341db1f666a2164ea63a67265c7f779bc12d6b3f2fa67e9",
        "url": "https://raw.githubusercontent.com/opencv/opencv/07e29c2ac4281bccdebedd9081a99ac48fcef2d5/samples/dnn/face_detector/deploy.prototxt",
        "about": "Configurazione del rilevatore di volti",
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
        got = sha256_file(tmp)
        if got != spec["sha256"]:
            tmp.unlink(missing_ok=True)
            raise SystemExit(f"Impronta del modello {spec['file']} diversa da quella attesa "
                             f"({got[:12]}... invece di {spec['sha256'][:12]}...): download scartato.")
        tmp.rename(path)
    elif sha256_file(path) != spec["sha256"]:
        raise SystemExit(f"Il modello in cache {path} non corrisponde all'impronta attesa: "
                         "cancellalo e rilancia 'sopralluogo models'.")
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
