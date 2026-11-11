#!/usr/bin/env bash
# Turnkey installer for the dictaphone-opencode plugin (Linux, user scope).
#
#   ./install.sh [model]
#
# - Builds the GUI bundle when npm is available and dist is missing.
# - Installs the built-in local transcription engine (uv) unless
#   DICTAPHONE_SKIP_SERVER=1. No server, no port, no systemd unit.
# - Adds this directory to ~/.config/opencode/opencode.json.

set -euo pipefail

PLUGIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${1:-}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
CONFIG="$CONFIG_DIR/opencode.json"

if [[ ! -f "$PLUGIN_DIR/dist/gui-experimental.cjs" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "dist/gui-experimental.cjs is missing and npm is not installed." >&2
    echo "Build it on another machine or install Node.js, then run npm install && npm run build." >&2
    exit 1
  fi
  echo "Building the GUI bundle…"
  (cd "$PLUGIN_DIR" && npm install --no-audit --no-fund && npm run build)
fi

if [[ "${DICTAPHONE_SKIP_SERVER:-0}" != "1" ]]; then
  if [[ -n "$MODEL" ]]; then
    "$PLUGIN_DIR/local-server/install.sh" "$MODEL"
  else
    "$PLUGIN_DIR/local-server/install.sh"
  fi
fi

mkdir -p "$CONFIG_DIR"
PLUGIN_DIR="$PLUGIN_DIR" CONFIG="$CONFIG" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["CONFIG"])
plugin_dir = os.environ["PLUGIN_DIR"]
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise SystemExit(f"Cannot parse {path}: {error}. Add the plugin manually.")
    if not isinstance(data, dict):
        raise SystemExit(f"{path} does not contain a JSON object.")

plugins = data.setdefault("plugins", [])
if not isinstance(plugins, list):
    raise SystemExit(f"'plugins' in {path} is not an array.")
if plugin_dir not in plugins:
    plugins.append(plugin_dir)
data.setdefault("$schema", "https://opencode.ai/config.json")
path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"Plugin registered in {path}")
PY

echo
echo "Done. Restart OpenCode Desktop, then use the microphone button in a session,"
echo "Ctrl+Shift+M, or /voice."
