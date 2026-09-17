"""Local speech-to-text server for God's Eye View.

Wraps faster-whisper behind a tiny localhost-only HTTP API:
  GET  /health      -> {"ok": true, "model": ..., "device": ...}
  POST /transcribe  -> body: audio bytes (WAV/WebM/OGG), returns {"text": ...}

Audio is decoded in memory and never written to disk.
"""

import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_VOICE_STT_PORT", "5181"))
MODEL = os.environ.get("LOCAL_VOICE_STT_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("LOCAL_VOICE_STT_DEVICE", "cuda")
LANGUAGE = os.environ.get("LOCAL_VOICE_STT_LANGUAGE", "en")
MAX_BYTES = 25 * 1024 * 1024

# Place names and app vocabulary Whisper would otherwise mishear.
PROMPT = os.environ.get(
    "LOCAL_VOICE_STT_PROMPT",
    "Commands for a 3D globe: fly to Rosyth, Dunfermline, Edinburgh, the Forth "
    "bridges. Show flights, satellites, CCTV, vessels. Track that aircraft. "
    "Thermal, night vision, noir.",
)


def add_cuda_dll_dirs():
    """Windows: make the pip-installed cuBLAS/cuDNN DLLs loadable."""
    if sys.platform != "win32":
        return
    nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for bin_dir in nvidia.glob("*/bin"):
        os.add_dll_directory(str(bin_dir))
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


add_cuda_dll_dirs()
from faster_whisper import WhisperModel  # noqa: E402

print(f"[local-voice] loading {MODEL} on {DEVICE}...", flush=True)
started = time.time()
model = WhisperModel(
    MODEL,
    device=DEVICE,
    compute_type="float16" if DEVICE == "cuda" else "int8",
)
print(f"[local-voice] model ready in {time.time() - started:.1f}s", flush=True)
model_lock = Lock()


def transcribe(audio: bytes) -> dict:
    started = time.time()
    with model_lock:
        segments, info = model.transcribe(
            io.BytesIO(audio),
            language=LANGUAGE or None,
            initial_prompt=PROMPT or None,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "audioSeconds": round(info.duration, 2),
        "elapsedMs": round((time.time() - started) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "model": MODEL, "device": DEVICE})
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"error": "Not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self.reply(413, {"error": "Audio missing or too large"})
        try:
            self.reply(200, transcribe(self.rfile.read(length)))
        except Exception as error:  # noqa: BLE001 - report any decode/model failure
            self.reply(500, {"error": str(error)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"[local-voice] listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
