#!/usr/bin/env python3
"""Expose verified-backup metrics and receive Alpha Alertmanager webhooks."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MANIFEST_DIR = Path(os.environ.get("MANIFEST_DIR", "/var/lib/ailearn/manifests"))
MAX_ALERT_BYTES = 1024 * 1024


def parse_timestamp(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def collect_backup_metrics() -> str:
    latest_timestamp: float | None = None
    verified_count = 0
    scan_errors = 0

    try:
        manifests = list(MANIFEST_DIR.glob("*.manifest.json"))
    except OSError:
        manifests = []
        scan_errors += 1

    for path in manifests:
        try:
            with path.open(encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, json.JSONDecodeError):
            scan_errors += 1
            continue

        if manifest.get("verificationStatus") != "verified":
            continue
        timestamp = parse_timestamp(manifest.get("completedAt"))
        if timestamp is None:
            scan_errors += 1
            continue
        verified_count += 1
        latest_timestamp = timestamp if latest_timestamp is None else max(latest_timestamp, timestamp)

    lines = [
        "# HELP ailearn_backup_verified_manifests_total Number of locally retained verified backup manifests.",
        "# TYPE ailearn_backup_verified_manifests_total gauge",
        f"ailearn_backup_verified_manifests_total {verified_count}",
        "# HELP ailearn_backup_manifest_scan_errors Number of manifest read or validation errors in the latest scan.",
        "# TYPE ailearn_backup_manifest_scan_errors gauge",
        f"ailearn_backup_manifest_scan_errors {scan_errors}",
    ]
    if latest_timestamp is not None:
        lines.extend(
            [
                "# HELP ailearn_db_last_successful_backup_timestamp Unix timestamp of the newest deeply verified backup.",
                "# TYPE ailearn_db_last_successful_backup_timestamp gauge",
                f"ailearn_db_last_successful_backup_timestamp {latest_timestamp:.0f}",
            ]
        )
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    server_version = "AILearnAlphaOps/1.0"

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("[alpha-ops] " + format % args + "\n")

    def send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self.send_bytes(HTTPStatus.OK, b'{"status":"ok"}\n', "application/json")
            return
        if self.path == "/metrics":
            self.send_bytes(
                HTTPStatus.OK,
                collect_backup_metrics().encode(),
                "text/plain; version=0.0.4; charset=utf-8",
            )
            return
        self.send_bytes(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/alerts":
            self.send_bytes(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_ALERT_BYTES:
            self.send_bytes(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"invalid payload size\n", "text/plain")
            return
        payload = self.rfile.read(length)
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError:
            self.send_bytes(HTTPStatus.BAD_REQUEST, b"invalid json\n", "text/plain")
            return
        print("[alpha-ops] alertmanager webhook " + json.dumps(decoded, ensure_ascii=False), flush=True)
        self.send_bytes(HTTPStatus.OK, b'{"status":"accepted"}\n', "application/json")


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[alpha-ops] listening on :{port}; manifests={MANIFEST_DIR}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
