#!/usr/bin/env bash
# Installa pipeline e visualizzatore. Uso: ./scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v ffmpeg >/dev/null || { echo "Installa FFmpeg prima di continuare (https://ffmpeg.org)"; exit 1; }
command -v node >/dev/null || { echo "Installa Node.js 18+ prima di continuare"; exit 1; }
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -q -e pipeline
pipeline/.venv/bin/sopralluogo models
(cd viewer && npm install --no-audit --no-fund && npm run build)
echo
echo "Fatto. Attiva l'ambiente con:  source pipeline/.venv/bin/activate"
echo "Poi:  sopralluogo process video.mp4 -o casi/prova && sopralluogo serve casi/prova"
