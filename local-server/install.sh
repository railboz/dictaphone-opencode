#!/usr/bin/env bash
# Installs the local transcription engine used by the dictaphone-opencode plugin.
#
# Usage:
#   ./install.sh [model]
#
# The model defaults to large-v3-turbo when an NVIDIA GPU is detected,
# otherwise to small. The plugin starts the engine on demand over stdin/stdout:
# there is no HTTP server, no port and no systemd unit.
#
# This script also removes the former systemd service when it is still there.

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
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dictaphone-opencode.service"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

# Migrate away from the old HTTP service: the plugin now starts the engine
# itself, so the unit would only duplicate the model in memory.
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now dictaphone-opencode.service >/dev/null 2>&1 || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$UNIT"

mkdir -p "$DATA_DIR/models"
cp "$SCRIPT_DIR/server.py" "$DATA_DIR/server.py"
printf '%s\n' "$MODEL" > "$DATA_DIR/model"

if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv --python /usr/bin/python3 "$VENV"
fi

uv pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt"

if [[ "$HAS_GPU" == "1" ]] && ! "$VENV/bin/python" -c 'import nvidia.cublas.lib, nvidia.cudnn.lib' >/dev/null 2>&1; then
  echo "NVIDIA GPU detected: installing CUDA libraries…"
  uv pip install --python "$VENV/bin/python" nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'
fi

echo "Preparing model $MODEL (the first run downloads it)…"
if ! "$VENV/bin/python" "$DATA_DIR/server.py" \
  --prepare \
  --model "$MODEL" \
  --model-dir "$DATA_DIR/models" \
  --device auto \
  --beam-size 5; then
  echo "Warning: the model could not be prepared now; the plugin will download it on first use." >&2
fi

echo
echo "Local transcription engine installed."
echo "  Model:  $MODEL"
echo "  Device: auto (CUDA if available, otherwise CPU)"
echo "  Mode:   on-demand process started by the plugin (no server, no port)"
echo
echo "Restart OpenCode Desktop to use it."
