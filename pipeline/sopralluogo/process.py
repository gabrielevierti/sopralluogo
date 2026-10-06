"""End-to-end processing of one or more videos into a case folder."""
from __future__ import annotations

import json
import platform
import time
from pathlib import Path

import cv2
import numpy as np

from . import __version__
from .background import camera_motion, median_background
from .calibrate import (calibrate_from_depth, calibrate_from_people, fit_disparity_to_metric,
                        person_samples, vertical_segments)
from .log import journal, log
from .models import model_info, sha256_file
from .multicam import align_by_points, align_by_tracks, audio_offset
from .nets import DepthNet, Detector
from .reconstruct import depth_mesh, metric_depth, trajectories
from .track import Tracker
from .video import FrameReader, evidence_record, make_proxy, probe, require_ffmpeg


def _depth_preview(z: np.ndarray) -> np.ndarray:
    inv = 1.0 / z
    lo, hi = np.nanpercentile(inv, 2), np.nanpercentile(inv, 98)
    n = np.clip((inv - lo) / (hi - lo + 1e-9), 0, 1)
    img = cv2.applyColorMap((np.nan_to_num(n) * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
    img[~np.isfinite(z)] = 0
    return img


def process_camera(video: Path, cam_id: str, out: Path, opts: dict) -> dict:
    log(f"=== Camera {cam_id}: {video.name}")
    meta = probe(video)
    evidence = evidence_record(video)
    log(f"SHA-256 originale: {evidence['sha256']}")
    w, h, fps = meta["width"], meta["height"], meta["fps"]
    cam_dir = out / "cameras" / cam_id
    cam_dir.mkdir(parents=True, exist_ok=True)
    make_proxy(video, out / "media" / f"{cam_id}.mp4")

    reader = FrameReader(video)
    if reader.fps:
        fps = reader.fps
    sample = reader.sample(opts["bg_frames"])
    motion = camera_motion(sample)
    if not motion["static"]:
        log(f"ATTENZIONE: la camera sembra muoversi (spostamento max {motion['max_px']:.1f} px). "
            "Il modello a camera fissa produrra' risultati poco affidabili.")
    bg = median_background(sample)
    cv2.imwrite(str(cam_dir / "background.jpg"), bg, [cv2.IMWRITE_JPEG_QUALITY, 92])

    # ---- detection + tracking over the whole clip
    stride = max(1, int(round(fps / opts["analysis_fps"])))
    det = Detector(imgsz=opts["imgsz"], conf=opts["conf"])
    tracker = Tracker(max_gap_frames=int(fps * 1.0))
    t0 = time.time()
    n_frames = 0
    for fi, _, frame in reader.iterate(stride):
        tracker.update(fi, det(frame))
        n_frames += 1
        if n_frames % 25 == 0:
            log(f"  analizzati {n_frames} fotogrammi ({fi}/{reader.n})")
    reader.close()
    tracks = tracker.finish()
    log(f"Rilevamento: {len(tracks)} soggetti tracciati in {time.time() - t0:.0f} s")

    # ---- depth of the static scene
    disp = DepthNet()(bg)

    # ---- calibration
    samples = person_samples(tracks, w, h)
    calib = None
    if not opts["no_people_calib"]:
        verticals = vertical_segments(bg)
        log(f"Linee verticali della scena usate per la calibrazione: {len(verticals)}")
        calib = calibrate_from_people(samples, w, h, opts["hfov"], opts["person_height"], verticals)
    if calib is not None:
        cam, report = calib
        a, b, inl = fit_disparity_to_metric(disp, cam, samples)
        report["depth_fit_inliers"] = inl
    else:
        cam, report, (a, b) = calibrate_from_depth(disp, w, h, opts["hfov"] or 60.0, opts["camera_height"])

    z, ground = metric_depth(disp, a, b, cam, opts["max_depth"])
    cv2.imwrite(str(cam_dir / "depth.png"), _depth_preview(z))
    verts, cols, faces, mesh_info = depth_mesh(bg, z, ground, cam, stride=opts["mesh_stride"])
    verts.tofile(cam_dir / "mesh_pos.f32")
    cols.tofile(cam_dir / "mesh_col.u8")
    faces.tofile(cam_dir / "mesh_idx.u32")
    log(f"Mesh: {mesh_info['vertices']} vertici, {mesh_info['faces']} facce")

    trajs = trajectories(tracks, cam, fps, stride, w, h, max_gap=int(fps * 1.0))
    with open(cam_dir / "tracks.json", "w") as f:
        json.dump(trajs, f, separators=(",", ":"))

    return {
        "id": cam_id,
        "label": video.stem,
        "video": f"media/{cam_id}.mp4",
        "fps": fps, "duration": meta["duration"], "width": w, "height": h,
        "time_offset": 0.0,
        "alignment": np.eye(4).tolist(),
        "camera": cam.to_json(),
        "calibration": report,
        "camera_motion": motion,
        "mesh": {"positions": f"cameras/{cam_id}/mesh_pos.f32", "colors": f"cameras/{cam_id}/mesh_col.u8",
                 "indices": f"cameras/{cam_id}/mesh_idx.u32", **mesh_info},
        "background": f"cameras/{cam_id}/background.jpg",
        "depth_preview": f"cameras/{cam_id}/depth.png",
        "tracks": f"cameras/{cam_id}/tracks.json",
        "analysis": {"stride_frames": stride, "frames_analysed": n_frames},
        "evidence": {**evidence, "probe": meta},
        "_tracks_data": trajs,
    }


def run(videos: list[Path], out: Path, opts: dict) -> Path:
    require_ffmpeg()
    out.mkdir(parents=True, exist_ok=True)
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    cams = []
    for i, v in enumerate(videos, start=1):
        cams.append(process_camera(v, f"cam{i}", out, opts))

    # ---- time synchronisation
    manual = opts.get("offsets") or {}
    for c, v in zip(cams[1:], videos[1:]):
        if c["id"] in manual:
            c["time_offset"] = float(manual[c["id"]])
            c["sync"] = {"method": "manuale"}
        elif opts.get("audio_sync", True) and c["evidence"]["probe"]["has_audio"] \
                and cams[0]["evidence"]["probe"]["has_audio"]:
            r = audio_offset(videos[0], v)
            if r:
                c["time_offset"], conf = r
                c["sync"] = {"method": "audio", "confidence": conf}
                log(f"Sincronizzazione audio {c['id']}: {r[0]:+.2f} s (affidabilita' {conf:.2f})")
        else:
            c["sync"] = {"method": "nessuna", "warning": "Video non sincronizzati: impostare l'offset."}

    # ---- spatial alignment of extra cameras into cam1's frame
    pts = opts.get("align_points") or {}
    for c in cams[1:]:
        res = None
        if c["id"] in pts:
            res = align_by_points(pts[c["id"]])
        else:
            res = align_by_tracks(cams[0]["_tracks_data"], c["_tracks_data"], cams[0]["time_offset"],
                                  c["time_offset"])
        if res:
            c["alignment"], c["alignment_report"] = res[0].tolist(), res[1]
        else:
            c["alignment_report"] = {"method": "nessuno", "warning": "Camera non allineata: "
                                     "indicare punti comuni nel visualizzatore."}
            log(f"{c['id']}: allineamento automatico non riuscito")

    for c in cams:
        c.pop("_tracks_data", None)

    scene = {
        "format": "sopralluogo-case/1",
        "title": opts.get("title") or out.name,
        "created": started,
        "units": "metri",
        "up": "Y",
        "cameras": cams,
        "duration": max(c["duration"] + c["time_offset"] for c in cams) - min(c["time_offset"] for c in cams),
        "time_start": min(c["time_offset"] for c in cams),
        "notes": [
            "Misure derivate da stima monoculare: vanno verificate con almeno una misura nota sul posto.",
            "La scala dipende dall'altezza media assunta per le persone (vedi calibration).",
        ],
    }
    with open(out / "scene.json", "w") as f:
        json.dump(scene, f, indent=1)

    # ---- integrity manifest: what went in, what came out, with which software
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "manifest.json")
    manifest = {
        "software": {"name": "sopralluogo", "version": __version__, "python": platform.python_version(),
                     "platform": platform.platform(), "opencv": cv2.__version__},
        "models": [model_info("depth"), model_info("detector")],
        "parameters": {k: v for k, v in opts.items() if k not in ("align_points",)},
        "inputs": [c["evidence"] for c in cams],
        "outputs": [{"path": str(p.relative_to(out)), "sha256": sha256_file(p)} for p in files],
        "started": started, "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "journal": journal(),
    }
    with open(out / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    log(f"Caso scritto in {out}")
    return out
