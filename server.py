#!/usr/bin/env python3
"""Local server for the OCR PoC.

Serves the page and relays Cloud Vision requests, so the API key stays in this
process (read from the environment or .env) and never reaches the browser.

    python3 server.py            # http://localhost:8765

Only the Python standard library is used.
"""

import base64
import binascii
import json
import os
import threading
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"  # never listen on the LAN: the relay spends your quota
PORT = int(os.environ.get("PORT", "8765"))
VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
MAX_BODY_BYTES = 15 * 1024 * 1024
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

# Only these files are served. Anything else (.env, this script) is a 404.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

CSP = "; ".join([
    "default-src 'none'",
    "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
    "worker-src blob:",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
])


def load_dotenv(path):
    """Read KEY=VALUE lines into os.environ without overriding real env vars."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv(ROOT / ".env")
API_KEY = os.environ.get("GOOGLE_CLOUD_VISION_API_KEY", "").strip()
# Guard against a runaway loop burning through paid quota.
MAX_VISION_REQUESTS = int(os.environ.get("VISION_MAX_REQUESTS", "100"))
vision_count = 0
vision_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "ocr-poc"
    sys_version = ""

    def do_GET(self):
        if not self._host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/vision/status":
            return self._json(HTTPStatus.OK, {
                "configured": bool(API_KEY),
                "remaining": max(0, MAX_VISION_REQUESTS - vision_count),
            })
        if path not in STATIC_FILES:
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        name, content_type = STATIC_FILES[path]
        body = (ROOT / name).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self._common_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global vision_count
        if not self._host_ok():
            return
        if self.path != "/api/vision":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        # Same-origin fetches always send Origin on POST; anything else is another site.
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            return self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
        if self.headers.get_content_type() != "application/json":
            return self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "application/json only"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY_BYTES:
            return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "image too large"})
        if not API_KEY:
            return self._json(HTTPStatus.SERVICE_UNAVAILABLE, {
                "error": "GOOGLE_CLOUD_VISION_API_KEY が設定されていません（README を参照）",
            })

        try:
            image = json.loads(self.rfile.read(length))["image"]
            base64.b64decode(image, validate=True)
        except (ValueError, KeyError, TypeError, binascii.Error):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid image"})

        with vision_lock:
            if vision_count >= MAX_VISION_REQUESTS:
                return self._json(HTTPStatus.TOO_MANY_REQUESTS, {
                    "error": f"このサーバーでの上限 {MAX_VISION_REQUESTS} 件に達しました（VISION_MAX_REQUESTS で変更、再起動でリセット）",
                })
            vision_count += 1

        # The request shape is fixed here, so the relay can only do text detection.
        payload = json.dumps({"requests": [{
            "image": {"content": image},
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
        }]}).encode()
        req = urllib.request.Request(VISION_URL, data=payload, method="POST", headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": API_KEY,
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return self._raw_json(res.status, res.read())
        except urllib.error.HTTPError as e:
            return self._raw_json(e.code, e.read())
        except urllib.error.URLError as e:
            return self._json(HTTPStatus.BAD_GATEWAY, {"error": f"Cloud Vision に接続できません: {e.reason}"})

    # Reject other Host headers so a DNS-rebinding page cannot reach the relay.
    def _host_ok(self):
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self._json(HTTPStatus.FORBIDDEN, {"error": "host not allowed"})
        return False

    def _common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status, obj):
        self._raw_json(status, json.dumps(obj, ensure_ascii=False).encode())

    def _raw_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._common_headers()
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    state = "設定済み" if API_KEY else "未設定（Tesseract のみ使えます）"
    print(f"OCR PoC: http://localhost:{PORT}  Cloud Vision キー: {state}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
