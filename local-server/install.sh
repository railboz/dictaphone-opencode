#!/usr/bin/env bash
# Installs the local transcription server used by the dictaphone-opencode plugin.
#
# Usage:
#   ./install.sh [model]
#
# The model defaults to large-v3-turbo when an NVIDIA GPU is detected,
# otherwise to small. The server listens on http://127.0.0.1:8178 and is
# managed by the dictaphone-opencode systemd user service.

set -euo pipefail

HAS_GPU=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_GPU=1
fi

DEFAULT_MODEL="small"
if [[ "$HAS_GPU" == "1" ]]; then
  DEFAULT_MODEL="large-v3-turbo"
fi
MODEL="${1:-$DEFAULT_MODEL}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dictaphone-opencode"
VENV="$DATA_DIR/venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/dictaphone-opencode.service"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/models" "$UNIT_DIR"
cp "$SCRIPT_DIR/server.py" "$DATA_DIR/server.py"

if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv --python /usr/bin/python3 "$VENV"
fi

uv pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt"

if [[ "$HAS_GPU" == "1" ]] && ! "$VENV/bin/python" -c 'import nvidia.cublas.lib, nvidia.cudnn.lib' >/dev/null 2>&1; then
  echo "NVIDIA GPU detected: installing CUDA libraries…"
  uv pip install --python "$VENV/bin/python" nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Local transcription server for dictaphone-opencode
After=network.target

[Service]
Type=simple
WorkingDirectory=$DATA_DIR
ExecStart=$VENV/bin/python $DATA_DIR/server.py --model $MODEL --device auto --beam-size 5 --port 8178
Environment=PYTHONUNBUFFERED=1
Environment=HF_HUB_DISABLE_TELEMETRY=1
Restart=on-failure
RestartSec=3
Nice=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now dictaphone-opencode.service

echo
echo "Local transcription server installed."
echo "  Model:    $MODEL"
echo "  Device:   auto (CUDA if available, otherwise CPU)"
echo "  Endpoint: http://127.0.0.1:8178/transcribe"
echo "  Logs:     journalctl --user -u dictaphone-opencode -f"
echo
echo "The first server start downloads the model (a few hundred MB to ~1.6 GB)."
