"""Integrity of a case folder.

The manifest lists the SHA-256 of every file the analysis produced. Checking files against
the manifest proves they were not changed *relative to the manifest*; whoever can edit a file
can also rewrite the manifest. The fingerprint of manifest.json itself (the "impronta del
caso") closes the loop: written in the report/verbale at the end of the analysis, kept outside
the folder, it lets anyone check later that the manifest, and therefore every file, is intact.
"""
from __future__ import annotations

import json
from pathlib import Path

from .models import sha256_file

# files an operator may legitimately add after the analysis
OPERATOR_FILES = {"workspace.json"}


def case_fingerprint(case: Path) -> str:
    return sha256_file(case / "manifest.json")


def verify(case: Path, originals: list[Path] | None = None, progress=None) -> dict:
    case = Path(case)
    mpath = case / "manifest.json"
    if not mpath.exists():
        raise SystemExit(f"{case} non contiene manifest.json: impossibile verificare.")
    manifest = json.loads(mpath.read_text())
    listed = {o["path"]: o for o in manifest["outputs"]}
    changed, missing, ok = [], [], 0
    for i, (rel, o) in enumerate(sorted(listed.items())):
        if progress:
            progress(i, len(listed), rel)
        p = case / rel
        if not p.is_file():
            missing.append(rel)
        elif sha256_file(p) != o["sha256"]:
            changed.append(rel)
        else:
            ok += 1
    present = {str(p.relative_to(case)) for p in case.rglob("*") if p.is_file()}
    added = sorted(present - set(listed) - {"manifest.json"} - OPERATOR_FILES)
    operator = sorted(present & OPERATOR_FILES)

    orig = []
    by_hash = {e["sha256"]: e for e in manifest.get("inputs", [])}
    for f in originals or []:
        h = sha256_file(f)
        e = by_hash.get(h)
        orig.append({"file": str(f), "sha256": h, "matches": e["file_name"] if e else None})

    return {
        "fingerprint": case_fingerprint(case),
        "files": len(listed), "ok": ok, "changed": changed, "missing": missing,
        "added": added, "operator_files": operator, "originals": orig,
        "intact": not changed and not missing and not added and all(o["matches"] for o in orig),
    }


def format_report(r: dict, expected: str | None = None) -> str:
    lines = [f"Impronta del caso (SHA-256 di manifest.json): {r['fingerprint']}"]
    if expected:
        same = expected.strip().lower() == r["fingerprint"]
        lines.append("  coincide con quella a verbale" if same else
                     f"  NON coincide con quella a verbale ({expected.strip()})")
    lines.append(f"File elaborati: {r['ok']} di {r['files']} corrispondono al manifest")
    for k, label in (("changed", "MODIFICATO"), ("missing", "MANCANTE"), ("added", "AGGIUNTO (non nel manifest)")):
        for p in r[k]:
            lines.append(f"  {label}: {p}")
    for p in r["operator_files"]:
        lines.append(f"  area di lavoro dell'operatore (non fa parte dell'elaborazione): {p}")
    for o in r["originals"]:
        lines.append(f"Originale {o['file']}: " + (f"corrisponde a {o['matches']}" if o["matches"]
                                                     else "NON corrisponde a nessun video elaborato"))
    lines.append("ESITO: integro" if r["intact"] and (not expected or expected.strip().lower() == r["fingerprint"])
                 else "ESITO: NON integro")
    return "\n".join(lines)
