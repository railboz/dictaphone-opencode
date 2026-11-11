#!/usr/bin/env python3
"""Local transcription engine used by the dictaphone-opencode plugin.

The plugin starts it on demand as a stdio worker: newline-delimited JSON in,
newline-delimited JSON out. No port, no HTTP service, no systemd unit.

The same script can still run as an HTTP server for advanced setups, with a
raw audio body or a multipart/form-data request compatible with OpenAI clients:

  GET  /health
  POST /transcribe
  POST /inference
  POST /v1/audio/transcriptions
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import sys
import tempfile
import threading
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


def preload_cuda_libraries() -> None:
    """Load the CUDA libraries shipped by the nvidia-* wheels, if present."""
    try:
        import nvidia
    except ImportError:
        return

    roots = [Path(root) for root in getattr(nvidia, "__path__", [])]
    libraries = (
        "cublas/lib/libcublas.so.12",
        "cublas/lib/libcublasLt.so.12",
        "cudnn/lib/libcudnn.so.9",
        "cuda_nvrtc/lib/libnvrtc.so.12",
    )
    for relative in libraries:
        for root in roots:
            candidate = root / relative
            if not candidate.exists():
                continue
            try:
                ctypes.CDLL(str(candidate), mode=ctypes.RTLD_GLOBAL)
            except OSError as error:
                print(
                    f"Could not preload {candidate}: {error}",
                    file=sys.stderr,
                    flush=True,
                )
            break


preload_cuda_libraries()

from faster_whisper import WhisperModel  # noqa: E402

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
runtime_device = "cpu"
runtime_compute_type = "int8"
stdio_mode = False
transcribe_lock = threading.Lock()


def log(message: str) -> None:
    """Logs to stderr in stdio mode so the JSON protocol on stdout stays clean."""
    print(message, file=sys.stderr if stdio_mode else sys.stdout, flush=True)


def parse_multipart(
    content_type: str, body: bytes
) -> tuple[bytes | None, dict[str, str], str | None]:
    """Extract the uploaded file, text fields and file content type."""
    message = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: "
        + content_type.encode("utf-8")
        + b"\r\nMIME-Version: 1.0\r\n\r\n"
        + body
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
                fields[name] = payload.decode(
                    part.get_content_charset() or "utf-8"
                ).strip()
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


def transcribe_file(path: Path, language: str, prompt: str) -> tuple[str, Any]:
    """Transcribes one audio file and returns the text and faster-whisper info."""
    with transcribe_lock:
        segments, info = model.transcribe(
            str(path),
            language=None if language.lower() in ("", "auto") else language,
            beam_size=args.beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, info


def write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def worker_loop() -> None:
    """Serves one JSON request per stdin line until the parent closes the pipe."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("The request must be a JSON object.")
            request_id = request.get("id")
            if request.get("type") == "ping":
                write_response({"id": request_id, "ok": True, "text": ""})
                continue

            audio = request.get("audio")
            if not isinstance(audio, str) or not audio:
                raise ValueError("Missing base64 audio.")
            data = base64.b64decode(audio, validate=True)
            if not data:
                raise ValueError("Empty audio.")

            suffix = suffix_for(
                request.get("mimeType")
                if isinstance(request.get("mimeType"), str)
                else None,
                request.get("filename")
                if isinstance(request.get("filename"), str)
                else None,
            )
            path = Path(tempfile.mkstemp(prefix="dictation-", suffix=suffix)[1])
            try:
                path.write_bytes(data)
                language = str(request.get("language") or "fr")
                prompt = str(request.get("prompt") or "")
                text, info = transcribe_file(path, language, prompt)
            finally:
                try:
                    path.unlink()
                except OSError:
                    pass

            write_response(
                {
                    "id": request_id,
                    "ok": True,
                    "text": text,
                    "language": getattr(info, "language", language),
                    "duration": round(float(getattr(info, "duration", 0.0)), 2),
                    "model": args.model,
                }
            )
        except Exception as error:  # noqa: BLE001 - report the failure to the client
            log(f"transcription error: {error}")
            write_response({"id": request_id, "ok": False, "error": str(error)})


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
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Language, X-Filename, X-Prompt, X-Prompt-B64",
        )
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/v1/health", "/"):
            self.send_json(
                200,
                {
                    "ok": True,
                    "model": args.model,
                    "device": runtime_device,
                    "compute_type": runtime_compute_type,
                },
            )
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
        language = (
            self.headers.get("X-Language") or (query.get("language") or [""])[0] or "fr"
        ).strip()
        prompt = (
            self.headers.get("X-Prompt") or (query.get("prompt") or [""])[0] or ""
        ).strip()
        encoded_prompt = (
            self.headers.get("X-Prompt-B64")
            or (query.get("prompt_b64") or [""])[0]
            or ""
        ).strip()
        if encoded_prompt:
            try:
                prompt = (
                    base64.b64decode(encoded_prompt, validate=True)
                    .decode("utf-8")
                    .strip()
                )
            except (ValueError, UnicodeDecodeError):
                self.send_json(
                    400, {"ok": False, "error": "Invalid X-Prompt-B64 header"}
                )
                return
        filename: str | None = None
        audio = body

        if content_type.lower().startswith("multipart/form-data"):
            file_data, fields, file_type = parse_multipart(content_type, body)
            if file_data is None:
                self.send_json(
                    400, {"ok": False, "error": "Missing multipart file field"}
                )
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
            text, info = transcribe_file(path, language, prompt)
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


def cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001 - any CUDA probe failure means CPU
        return False


def choose_device() -> str:
    if args.device != "auto":
        return args.device
    return "cuda" if cuda_available() else "cpu"


def choose_model(requested: str) -> str:
    """Auto picks large-v3-turbo on CUDA and small on CPU."""
    if requested != "auto":
        return requested
    return "large-v3-turbo" if cuda_available() else "small"


def load_model() -> tuple[WhisperModel, str, str]:
    global runtime_device, runtime_compute_type
    device = choose_device()
    compute_type = args.compute_type
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    try:
        loaded = WhisperModel(
            args.model,
            device=device,
            compute_type=compute_type,
            cpu_threads=args.threads,
            download_root=args.model_dir,
        )
    except Exception as error:  # noqa: BLE001 - fall back to CPU on CUDA errors
        if device != "cuda":
            raise
        log(f"CUDA unavailable ({error}); falling back to CPU.")
        device = "cpu"
        compute_type = "int8"
        loaded = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            cpu_threads=args.threads,
            download_root=args.model_dir,
        )

    runtime_device = device
    runtime_compute_type = compute_type
    return loaded, device, compute_type


def main() -> None:
    global args, model, stdio_mode
    parser = argparse.ArgumentParser(
        description="Local transcription engine for dictaphone-opencode"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8178)
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="Read newline-delimited JSON requests on stdin and answer on stdout.",
    )
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="Load the model once and exit, used by the installer.",
    )
    parser.add_argument(
        "--model",
        default="auto",
        help="Model name, or auto (large-v3-turbo on CUDA, small on CPU).",
    )
    parser.add_argument(
        "--model-dir",
        default=str(Path.home() / ".local/share/dictaphone-opencode/models"),
    )
    parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 4))
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument(
        "--compute-type",
        default="auto",
        help="auto, float16, int8, int8_float16…",
    )
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()
    stdio_mode = args.stdio

    Path(args.model_dir).mkdir(parents=True, exist_ok=True)
    args.model = choose_model(args.model)
    log(f"loading model {args.model} (first run downloads it)…")
    model, device, compute_type = load_model()
    log(f"model ready on {args.model} ({device}, {compute_type})")

    if args.prepare:
        return

    if args.stdio:
        write_response(
            {
                "type": "ready",
                "model": args.model,
                "device": device,
                "compute_type": compute_type,
            }
        )
        worker_loop()
        return

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
