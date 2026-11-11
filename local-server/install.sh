#!/usr/bin/env bash
# Installs the local Whisper server used by the OpenCode Whisper plugin.
#
# Usage:
#   ./install.sh [model]     # model defaults to small
#
# The server listens on http://127.0.0.1:8178 and is managed by the
# opencode-whisper systemd user service.

set -euo pipefail

MODEL="${1:-small}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-whisper"
VENV="$DATA_DIR/venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/opencode-whisper.service"

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

cat > "$UNIT" <<EOF
[Unit]
Description=Local Whisper server for OpenCode
After=network.target

[Service]
Type=simple
WorkingDirectory=$DATA_DIR
ExecStart=$VENV/bin/python $DATA_DIR/server.py --model $MODEL --port 8178
Environment=PYTHONUNBUFFERED=1
Environment=HF_HUB_DISABLE_TELEMETRY=1
Restart=on-failure
RestartSec=3
Nice=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now opencode-whisper.service

echo
echo "Whisper local server installed."
echo "  Model:    $MODEL"
echo "  Endpoint: http://127.0.0.1:8178/transcribe"
echo "  Logs:     journalctl --user -u opencode-whisper -f"
echo
echo "The first server start downloads the model (a few hundred MB)."
