#!/usr/bin/env bash
# One-time Mac setup for discord-stage-recorder.
set -euo pipefail
cd "$(dirname "$0")"

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }

echo "▶ Installing Node, ffmpeg, whisper.cpp, OBS…"
brew install node ffmpeg whisper-cpp
brew install --cask obs || true   # skip if already installed

echo "▶ Downloading Whisper model (medium.en, ~1.5 GB)…"
mkdir -p models
[ -f models/ggml-medium.en.bin ] || \
  curl -L -o models/ggml-medium.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin

echo "▶ Installing npm dependencies…"
npm install

[ -f .env ] || { cp .env.example .env; echo "▶ Created .env — fill it in (see README.md)."; }

echo
echo "Done. Next:"
echo "  1. Fill in .env"
echo "  2. In OBS: Tools > WebSocket Server Settings > Enable, set password, copy into .env"
echo "  3. npm run register      (adds the /record command)"
echo "  4. npm run google-auth   (YouTube + Drive sign-in)"
echo "  5. npm start"
