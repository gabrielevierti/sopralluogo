"""Local, offline web server: viewer at /, case folder at /case/. Nothing leaves this machine."""
from __future__ import annotations

import functools
import os
import http.server
import webbrowser
from pathlib import Path

VIEWER_DIST = Path(__file__).resolve().parents[2] / "viewer" / "dist"


class _Handler(http.server.SimpleHTTPRequestHandler):
    case_dir: Path = Path(".")

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/case/"):
            rel = clean[len("/case/"):]
            target = (self.case_dir / rel).resolve()
            if self.case_dir.resolve() in target.parents or target == self.case_dir.resolve():
                return str(target)
            return str(self.case_dir / "__forbidden__")
        return super().translate_path(path)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        """Adds HTTP Range support: browsers need it to seek inside videos."""
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        try:
            unit, spec = rng.split("=", 1)
            start_s, end_s = spec.split(",")[0].split("-")
            size = os.path.getsize(path)
            if start_s == "":
                start, end = max(0, size - int(end_s)), size - 1
            else:
                start, end = int(start_s), int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if unit != "bytes" or start > end:
                raise ValueError
        except ValueError:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        try:
            if remaining is None:
                return super().copyfile(source, outputfile)
            while remaining > 0:
                buf = source.read(min(1 << 16, remaining))
                if not buf:
                    break
                outputfile.write(buf)
                remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser cancelled a request while scrubbing: normal
        finally:
            self._remaining = None


def serve(case: Path, port: int, open_browser: bool = True):
    if not (case / "scene.json").exists():
        raise SystemExit(f"{case} non contiene scene.json: non e' una cartella caso.")
    if not (VIEWER_DIST / "index.html").exists():
        raise SystemExit("Visualizzatore non compilato: esegui 'cd viewer && npm install && npm run build'.")
    _Handler.case_dir = case.resolve()
    handler = functools.partial(_Handler, directory=str(VIEWER_DIST))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/?case=/case/"
    print(f"Visualizzatore su {url}  (Ctrl+C per chiudere)")
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
