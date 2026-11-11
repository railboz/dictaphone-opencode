#!/usr/bin/env python3
"""Small local transcription HTTP server used by the dictaphone-opencode plugin.

It accepts either a raw audio body (the plugin's local mode) or a
multipart/form-data request compatible with OpenAI clients.

Endpoints:
  GET  /health
  POST /transcribe
  POST /inference
  POST /v1/audio/transcriptions
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel

MAX_BODY = 25 * 1024 * 1024
SUPPORTED_SUFFIXES = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/flac": ".flac",
}

args: argparse.Namespace
model: WhisperModel
model_lock = threading.Lock()
transcribe_lock = threading.Lock()


def log(message: str) -> None:
    print(message, flush=True)


def parse_multipart(content_type: str, body: bytes) -> tuple[bytes | None, dict[str, str], str | None]:
    """Extract the uploaded file, text fields and file content type."""
    message = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not message.is_multipart():
        return None, {}, None

    file_data: bytes | None = None
    fields: dict[str, str] = {}
    file_type: str | None = None
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if name == "file" or filename:
            if file_data is None:
                file_data = payload
                file_type = part.get_content_type()
        else:
            try:
                fields[name] = payload.decode(part.get_content_charset() or "utf-8").strip()
            except (LookupError, UnicodeDecodeError):
                fields[name] = payload.decode("utf-8", "replace").strip()
    return file_data, fields, file_type


def suffix_for(content_type: str | None, filename: str | None) -> str:
    if content_type:
        clean = content_type.split(";", 1)[0].strip().lower()
        if clean in SUPPORTED_SUFFIXES:
            return SUPPORTED_SUFFIXES[clean]
        if clean.startswith("audio/"):
            return "." + clean.split("/", 1)[1].split("+", 1)[0]
    if filename and "." in filename:
        return "." + filename.rsplit(".", 1)[1].lower()
    return ".wav"


class Handler(BaseHTTPRequestHandler):
    server_version = "dictaphone-opencode/1.0"

    def log_message(self, fmt: str, *values: Any) -> None:
        return

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Language")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/v1/health", "/"):
            self.send_json(200, {"ok": True, "model": args.model, "device": "cpu"})
            return
        self.send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/transcribe", "/inference", "/v1/audio/transcriptions"):
            self.send_json(404, {"ok": False, "error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self.send_json(400, {"ok": False, "error": "Empty request body"})
            return
        if length > MAX_BODY:
            self.send_json(413, {"ok": False, "error": "Audio is too large"})
            return

        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        query = parse_qs(parsed.query)
        language = (self.headers.get("X-Language") or (query.get("language") or [""])[0] or "fr").strip()
        prompt = (self.headers.get("X-Prompt") or (query.get("prompt") or [""])[0] or "").strip()
        filename: str | None = None
        audio = body

        if content_type.lower().startswith("multipart/form-data"):
            file_data, fields, file_type = parse_multipart(content_type, body)
            if file_data is None:
                self.send_json(400, {"ok": False, "error": "Missing multipart file field"})
                return
            audio = file_data
            language = fields.get("language", language) or language
            prompt = fields.get("prompt", prompt) or prompt
            content_type = file_type or "application/octet-stream"
            filename = "upload"

        suffix = suffix_for(content_type, filename)
        path = Path(tempfile.mkstemp(prefix="dictation-", suffix=suffix)[1])
        try:
            path.write_bytes(audio)
            with transcribe_lock:
                segments, info = model.transcribe(
                    str(path),
                    language=None if language.lower() == "auto" else language,
                    beam_size=args.beam_size,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 300},
                    initial_prompt=prompt or None,
                    condition_on_previous_text=False,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
            self.send_json(
                200,
                {
                    "ok": True,
                    "text": text,
                    "language": getattr(info, "language", language),
                    "duration": round(float(getattr(info, "duration", 0.0)), 2),
                    "model": args.model,
                },
            )
        except Exception as error:  # noqa: BLE001 - report the failure to the client
            log(f"transcription error: {error}")
            self.send_json(500, {"ok": False, "error": str(error)})
        finally:
            try:
                path.unlink()
            except OSError:
                pass


def main() -> None:
    global args, model
    parser = argparse.ArgumentParser(description="Local transcription server for dictaphone-opencode")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8178)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--model-dir", default=str(Path.home() / ".local/share/dictaphone-opencode/models"))
    parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 4))
    parser.add_argument("--beam-size", type=int, default=1)
    args = parser.parse_args()

    Path(args.model_dir).mkdir(parents=True, exist_ok=True)
    log(f"loading model {args.model} (first run downloads it)…")
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=args.threads,
        download_root=args.model_dir,
    )
    log(f"model ready on {args.model}")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
