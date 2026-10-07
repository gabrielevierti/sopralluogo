"""End-to-end processing of one or more videos into a case folder."""
from __future__ import annotations

import json
import os
import pickle
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
from .models import MODELS, model_info, models_dir, sha256_file
from .multicam import align_by_points, align_by_tracks, audio_offset
from .nets import DepthNet, Detector, Segmenter
from .reconstruct import depth_mesh, trajectories
from .planar import scene_surfaces
from .appearance import CropKeeper, FaceDetector, signature
from .describe import describe_track, save_views, white_balance_gains
from .reconstruct import building_volumes, drop_buildings_with_people, save_building_textures, floor_detail, snap_vertical_planes
from .masks import write_mask_atlas
from .fill import fill_behind
from .track import Tracker, WorldTracker, link_tracklets, renumber
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

    # developer cache (SOPRALLUOGO_DEV_CACHE=1): skip detection when iterating on later stages
    cache = cam_dir / "_dev_cache.pkl"
    if os.environ.get("SOPRALLUOGO_DEV_CACHE") and cache.exists():
        with open(cache, "rb") as f:
            frames_dets, keeper, samples, disp, cam, report, a, b, stride, n_frames = pickle.load(f)
        log("Uso la cache di sviluppo (rilevamento e calibrazione)")
    else:
        # ---- detection + tracking + appearance over the whole clip
        stride = max(1, int(round(fps / opts["analysis_fps"])))
        det = Detector(imgsz=opts["imgsz"], conf=opts["conf"])
        seg = Segmenter()
        tracker = Tracker(max_gap_frames=int(fps * 1.0))
        keeper = CropKeeper(k=8)
        frames_dets = []
        uid = 0
        t0 = time.time()
        n_frames = 0
        for fi, ts, frame in reader.iterate(stride):
            dets = det(frame)
            seg(frame, dets)
            for d in dets:
                sig = signature(frame, bg, d["bbox"])
                d["feat"], d["upper"], d["lower"] = sig["hist"], sig["upper"], sig["lower"]
                d["uid"] = uid
                uid += 1
            tracker.update(fi, dets)
            for d in dets:
                keeper.offer(d["_tid"], fi, fi / fps, frame, d["bbox"], d["conf"], d["uid"])
            frames_dets.append((fi, dets))
            n_frames += 1
            if n_frames % 25 == 0:
                log(f"  analizzati {n_frames} fotogrammi ({fi}/{reader.n})")
        reader.close()
        tracks = tracker.finish()
        log(f"Rilevamento: {len(tracks)} tracce in {time.time() - t0:.0f} s")

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

    if os.environ.get("SOPRALLUOGO_DEV_CACHE") and not cache.exists():
        with open(cache, "wb") as f:
            pickle.dump((frames_dets, keeper, samples, disp, cam, report, a, b, stride, n_frames), f)

    # ---- second pass: track again on the floor, in metres, with clothing (no new detection needed)
    for _, dets in frames_dets:
        for d in dets:
            d["_tid1"] = d.get("_tid")
    wt = WorldTracker(cam, fps, max_gap_frames=int(fps * 1.2))
    for fi, dets in frames_dets:
        wt.update(fi, dets)
    tracks = wt.finish()
    log(f"Tracciamento sul suolo: {len(tracks)} tracce")

    # ---- re-identification across occlusions, then final ids
    n_before = len(tracks)
    tracks = renumber(link_tracklets(tracks, cam, fps, max_gap_s=opts["reid_gap"]))
    log(f"Re-identificazione: {n_before} tracce unite in {len(tracks)} soggetti")

    # ---- surface
    max_depth = opts["max_depth"]
    if len(samples):
        zs, ok = cam.ground_depth(samples[:, 0], samples[:, 1])
        if ok.any():
            max_depth = min(max_depth, max(60.0, 2.5 * float(np.percentile(zs[ok], 98))))
    z, labels, planes, segments, patches = scene_surfaces(bg, disp, a, b, cam, max_depth)
    ground = labels == 1
    log(f"Superficie a tratti piani: suolo {ground.mean() * 100:.0f}% dell'immagine, muri raddrizzati: {len(planes)}")
    cv2.imwrite(str(cam_dir / "depth.png"), _depth_preview(z))
    verts, cols, quality, faces, kind, mesh_info = depth_mesh(bg, z, labels, cam, stride=opts["mesh_stride"],
                                                              segments=segments, patches=patches)
    kind.tofile(cam_dir / "mesh_kind.u8")
    verts.tofile(cam_dir / "mesh_pos.f32")
    cols.tofile(cam_dir / "mesh_col.u8")
    quality.tofile(cam_dir / "mesh_q.u8")
    # content-aware fill of what is hidden behind occluders, as a separate layer
    fill_info = None
    if not opts.get("no_fill"):
        bg_f, z_f, fmask, fill_info = fill_behind(bg, z, labels, planes, cam, max_depth)
        if fmask.any():
            cv2.imwrite(str(cam_dir / "background_filled.jpg"), bg_f, [cv2.IMWRITE_JPEG_QUALITY, 92])
            flabels = fill_info.pop("_labels")
            fv, fc, fq, ff, _, finfo = depth_mesh(bg_f, z_f, flabels, cam, stride=opts["mesh_stride"],
                                              region=fmask)
            fv.tofile(cam_dir / "fill_pos.f32")
            fq.tofile(cam_dir / "fill_q.u8")
            ff.tofile(cam_dir / "fill_idx.u32")
            fill_info.update(finfo)
    faces.tofile(cam_dir / "mesh_idx.u32")
    log(f"Mesh: {mesh_info['vertices']} vertici, {mesh_info['faces']} facce")
    buildings = building_volumes(planes, labels, z, bg, cam)
    detail = floor_detail(bg, ground, z, cam, cam_dir / "floor_detail.jpg")
    log(f"Edifici completati come volumi: {len(buildings)}; trama di dettaglio del pavimento: "
        f"{'si' if detail else 'no'}")

    trajs = trajectories(tracks, cam, fps, stride, w, h, max_gap=int(fps * 1.0))
    by_id = {t.id: t for t in tracks}
    faces_found = 0
    face_det = FaceDetector()
    gains = white_balance_gains(bg)
    for tr in trajs:
        t = by_id[tr["id"]]
        tr["appearance"] = describe_track(t, gains)
        uids = {d["uid"] for _, d in t.obs}
        tids1 = {d["_tid1"] for _, d in t.obs}
        tr["views"] = save_views(keeper.best(tids1, uids, k=4), cam_dir / "subjects" / str(t.id), f"cameras/{cam_id}/subjects/{t.id}",
                                 face_det)
        faces_found += sum(1 for v in tr["views"] if v.get("face"))
    log(f"Viste salvate per {len(trajs)} soggetti, volti rilevati in {faces_found} viste")
    mask_info = write_mask_atlas(trajs, by_id, stride, cam_dir / "masks.png")
    n_b = len(buildings)
    buildings = drop_buildings_with_people(buildings, trajs)
    if n_b != len(buildings):
        log(f"Scartati {n_b - len(buildings)} volumi attraversati da persone (non possono essere edifici)")
    save_building_textures(buildings, cam_dir, f"cameras/{cam_id}")
    with open(cam_dir / "tracks.json", "w") as f:
        json.dump(trajs, f, separators=(",", ":"), default=float)

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
                 "quality": f"cameras/{cam_id}/mesh_q.u8", "kind": f"cameras/{cam_id}/mesh_kind.u8",
                 "indices": f"cameras/{cam_id}/mesh_idx.u32", **mesh_info},
        "fill": None if not fill_info or not fill_info.get("faces") else {
            "positions": f"cameras/{cam_id}/fill_pos.f32", "indices": f"cameras/{cam_id}/fill_idx.u32",
            "quality": f"cameras/{cam_id}/fill_q.u8",
            "texture": f"cameras/{cam_id}/background_filled.jpg", **fill_info},
        "background": f"cameras/{cam_id}/background.jpg",
        "buildings": buildings,
        "floor_detail": None if not detail else {"texture": f"cameras/{cam_id}/floor_detail.jpg", **detail},
        "masks": None if not mask_info else {"atlas": f"cameras/{cam_id}/masks.png", **mask_info},
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
        "models": [model_info(k) for k in MODELS if (models_dir() / MODELS[k]["file"]).exists()],
        "parameters": {k: v for k, v in opts.items() if k not in ("align_points",)},
        "inputs": [c["evidence"] for c in cams],
        "outputs": [{"path": str(p.relative_to(out)), "sha256": sha256_file(p), "size_bytes": p.stat().st_size}
                    for p in files],
        "started": started, "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "journal": journal(),
    }
    with open(out / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=1)
    log(f"Caso scritto in {out}")
    log(f"Impronta del caso (da riportare a verbale): {sha256_file(out / 'manifest.json')}")
    return out
