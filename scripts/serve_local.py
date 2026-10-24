#!/usr/bin/env python3
"""Loopback-only static server mounted at /model-review/ for local verification."""
from __future__ import annotations

import argparse
import http.server
import mimetypes
import socketserver
from pathlib import Path
from urllib.parse import unquote, urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, default=Path("site"))
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
root = args.root.resolve()
if not root.is_dir():
    raise SystemExit(f"missing site root: {root}")

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ModelReviewLocal/1"

    def do_HEAD(self):
        self.serve(False)

    def do_GET(self):
        self.serve(True)

    def serve(self, body: bool):
        host = self.headers.get("Host", "").split(":", 1)[0]
        if host not in {"127.0.0.1", "localhost", "[::1]"}:
            self.send_error(421)
            return
        parsed = urlsplit(self.path)
        if parsed.path == "/model-review":
            self.send_response(308)
            self.send_header("Location", "/model-review/")
            self.end_headers()
            return
        if not parsed.path.startswith("/model-review/"):
            self.send_error(404)
            return
        relative = unquote(parsed.path[len("/model-review/"):]) or "index.html"
        parts = Path(relative).parts
        if Path(relative).is_absolute() or any(part in {"", ".", ".."} for part in parts):
            self.send_error(404)
            return
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if body:
            with target.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    self.wfile.write(chunk)

    def log_message(self, format, *values):
        print(f"{self.client_address[0]} {format % values}", flush=True)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

with Server(("127.0.0.1", args.port), Handler) as server:
    print(f"serving {root} at http://127.0.0.1:{args.port}/model-review/", flush=True)
    server.serve_forever()
