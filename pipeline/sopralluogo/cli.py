"""Command line: sopralluogo process | sync | serve | verify | models"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def _offsets(items):
    out = {}
    for it in items or []:
        k, v = it.split("=")
        out[k] = float(v)
    return out


def main(argv=None):
    p = argparse.ArgumentParser(prog="sopralluogo", description="Ricostruzione 3D misurabile da video.")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("process", help="analizza uno o piu' video e crea la cartella del caso")
    pr.add_argument("videos", nargs="+", type=Path, help="file video (stesso evento, punti di vista diversi)")
    pr.add_argument("-o", "--out", type=Path, required=True, help="cartella del caso da creare")
    pr.add_argument("--title", help="nome del caso")
    pr.add_argument("--hfov", type=float, default=None,
                    help="campo visivo orizzontale in gradi, se noto (default: stimato)")
    pr.add_argument("--person-height", type=float, default=1.70, help="altezza media persone per la scala (m)")
    pr.add_argument("--camera-height", type=float, default=3.0,
                    help="altezza camera ipotetica se non ci sono persone (m)")
    pr.add_argument("--no-people-calib", action="store_true", help="non usare le persone per calibrare")
    pr.add_argument("--analysis-fps", type=float, default=10.0, help="fotogrammi al secondo analizzati")
    pr.add_argument("--imgsz", type=int, default=960, help="risoluzione del rilevatore (piu' alta = soggetti piccoli)")
    pr.add_argument("--conf", type=float, default=0.30, help="soglia di confidenza del rilevatore")
    pr.add_argument("--max-depth", type=float, default=120.0, help="profondita' massima ricostruita (m)")
    pr.add_argument("--mesh-stride", type=int, default=2, help="1 = massima densita' della superficie")
    pr.add_argument("--reid-gap", type=float, default=4.0,
                    help="secondi massimi di scomparsa (es. dietro un palo) per riconoscere lo stesso soggetto")
    pr.add_argument("--no-fill", action="store_true", help="non ricostruire le zone nascoste dietro gli ostacoli")
    pr.add_argument("--bg-frames", type=int, default=60, help="fotogrammi per lo sfondo statico")
    pr.add_argument("--offset", action="append", metavar="CAM=SEC",
                    help="offset temporale manuale, es. cam2=1.35 (sostituisce la sincronizzazione audio)")
    pr.add_argument("--no-audio-sync", action="store_true")
    pr.add_argument("--align-points", type=Path,
                    help="JSON con coppie di punti per camera, esportato dal visualizzatore")

    sy = sub.add_parser("sync", help="calcola l'offset temporale tra due video dall'audio")
    sy.add_argument("reference", type=Path)
    sy.add_argument("other", type=Path)

    sv = sub.add_parser("serve", help="apre il visualizzatore su un caso")
    sv.add_argument("case", type=Path)
    sv.add_argument("--port", type=int, default=8737)
    sv.add_argument("--no-browser", action="store_true")

    sub.add_parser("models", help="scarica i modelli (per lavorare poi offline)")

    ve = sub.add_parser("verify", help="verifica che il caso non sia stato modificato")
    ve.add_argument("case", type=Path)
    ve.add_argument("--impronta", help="impronta del caso riportata a verbale, da confrontare")
    ve.add_argument("--originali", nargs="*", type=Path, default=[],
                    help="video originali da confrontare con quelli elaborati")
    ve.add_argument("--json", action="store_true", help="esito in JSON")

    a = p.parse_args(argv)
    if a.cmd == "process":
        from .process import run
        opts = {
            "title": a.title, "hfov": a.hfov, "person_height": a.person_height,
            "camera_height": a.camera_height, "no_people_calib": a.no_people_calib,
            "analysis_fps": a.analysis_fps, "imgsz": a.imgsz, "conf": a.conf, "max_depth": a.max_depth,
            "mesh_stride": a.mesh_stride, "reid_gap": a.reid_gap, "no_fill": a.no_fill, "bg_frames": a.bg_frames, "offsets": _offsets(a.offset),
            "audio_sync": not a.no_audio_sync,
            "align_points": json.loads(a.align_points.read_text()) if a.align_points else None,
        }
        run(a.videos, a.out, opts)
    elif a.cmd == "sync":
        from .multicam import audio_offset
        r = audio_offset(a.reference, a.other)
        if r is None:
            raise SystemExit("Audio assente o troppo breve in uno dei due video.")
        print(json.dumps({"offset_s": r[0], "confidence": r[1],
                          "meaning": "aggiungere offset_s al tempo del secondo video"}))
    elif a.cmd == "serve":
        from .serve import serve
        serve(a.case, a.port, not a.no_browser)
    elif a.cmd == "verify":
        from .integrity import format_report, verify
        r = verify(a.case, a.originali)
        good = r["intact"] and (not a.impronta or a.impronta.strip().lower() == r["fingerprint"])
        print(json.dumps({**r, "matches_expected": None if not a.impronta else good}, indent=1)
              if a.json else format_report(r, a.impronta))
        raise SystemExit(0 if good else 2)
    elif a.cmd == "models":
        from .models import MODELS, ensure_model
        for k in MODELS:
            print(ensure_model(k))


if __name__ == "__main__":
    main()
