"""Tiny logger that also keeps an in-memory journal for the case manifest."""
from __future__ import annotations

import sys
import time

_JOURNAL: list[dict] = []


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    _JOURNAL.append({"time": ts, "message": msg})
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


def journal() -> list[dict]:
    return list(_JOURNAL)
