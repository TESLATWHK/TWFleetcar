"""Local page for the HK fleet tracker."""

from __future__ import annotations

import json
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = 8766
STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def serve_static(handler: BaseHTTPRequestHandler, url_path: str) -> bool:
    if not url_path.startswith("/static/"):
        return False
    name = unquote(url_path.removeprefix("/static/"))
    static_root = (ROOT / "static").resolve()
    path = (static_root / name).resolve()
    try:
        relative = path.relative_to(static_root)
    except ValueError:
        handler._json({"error": "Not found"}, 404)
        return True
    if (
        not name
        or ".." in relative.parts
        or any(part.startswith(".") for part in relative.parts)
        or not path.is_file()
    ):
        handler._json({"error": "Not found"}, 404)
        return True
    content_type = STATIC_TYPES.get(path.suffix.lower())
    if not content_type:
        handler._json({"error": "Not found"}, 404)
        return True
    handler._file(path, content_type)
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print("[fleet]", fmt % args, flush=True)

    def _json(self, payload, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self._json({"error": "Not found"}, 404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/fleet"):
            self.send_response(302)
            self.send_header("Location", "/static/fleet.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if serve_static(self, path):
            return
        self._json({"error": "Not found"}, 404)


def lan_ip() -> str | None:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
        probe.close()
    except OSError:
        return None
    if not ip or ip.startswith("127."):
        return None
    return ip


def main() -> None:
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        raise SystemExit(f"Could not listen on {HOST}:{PORT}. {exc}") from exc
    local = f"http://127.0.0.1:{PORT}"
    print(f"Fleet on this PC  {local}", flush=True)
    shared = lan_ip()
    if shared:
        print(f"Fleet for colleagues on this Wi-Fi  http://{shared}:{PORT}", flush=True)
        print("Leave this window open. The link stops when this PC sleeps.", flush=True)
    threading.Timer(0.4, lambda: webbrowser.open(local)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
