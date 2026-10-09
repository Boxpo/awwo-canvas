#!/usr/bin/env python3
"""AwwO Canvas - minimal Python worker (protocol v1), standard library only.

It shows that a runtime is just a process speaking the worker protocol, in any language:

    GET    /health                  catalog
    POST   /internal/runs           one call, streamed as text/event-stream WorkerEvents
    DELETE /internal/runs/{runId}   stop that call
    POST   /internal/completions    one-shot call (the assistant router)

The "model" is deterministic: it answers in the exact shape of the node's frozen output contract,
so graph runs complete end to end. Replace generate() with a call into your own engine.

Hot-plug: with AWWO_REGISTER_URL=http://127.0.0.1:8787 the worker registers itself with the
orchestrator on start and unregisters on exit (Ctrl+C) - no orchestrator restart, no config edit.
"""
from __future__ import annotations

import atexit
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"
RUNTIME = os.environ.get("AWWO_PY_WORKER_RUNTIME", "python")
HOST = os.environ.get("AWWO_PY_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("AWWO_PY_WORKER_PORT", "8793"))
TOKEN = os.environ.get("AWWO_PY_WORKER_TOKEN", "")
REGISTER_URL = os.environ.get("AWWO_REGISTER_URL", "").rstrip("/")
API_TOKEN = os.environ.get("AWWO_API_TOKEN", "")
CONTRACT_HEADER = "Frozen graph output contract (server-owned serialization policy):"
MAX_BODY = 4 * 1024 * 1024

ACTIVE: dict[str, threading.Event] = {}
LOCK = threading.Lock()


def models() -> list[dict]:
    return [{"id": "py-echo", "model": "py-echo", "provider": "python", "runtime": RUNTIME, "label": "Python · echo",
             "maxContextTextBytes": 262144, "messageOverheadBytes": 16, "reasoningEfforts": []}]


def json_after(text: str, header: str):
    """The JSON value on the first non-empty line after `header` (the orchestrator writes it on one line)."""
    index = text.find(header)
    if index < 0:
        return None
    for line in text[index + len(header):].splitlines():
        if line.strip():
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None


def field_value(field: dict, gist: str):
    kind = field.get("type")
    if kind == "number":
        return 1
    if kind == "boolean":
        return True
    if kind == "html":
        return f"<!doctype html><html><head><meta charset=\"utf-8\"><title>{field.get('label', '')}</title></head><body><p>{gist}</p></body></html>"
    if kind == "file":
        return f"python://{field.get('id', 'file')}.txt"
    return f"### {field.get('label', field.get('id', ''))}\n\n(Python worker) {gist}"


def generate(request: dict) -> str:
    """Decide the whole answer for one call. Replace this with your engine."""
    system = str(request.get("systemPrompt") or "")
    prompt = str(request.get("prompt") or "")
    gist = re.sub(r"\s+", " ", prompt).strip()[:160]
    if re.search(r"canvas planner", system, re.I):
        return json.dumps({"version": 1, "operations": [],
                           "summary": "The Python demo worker does not plan. Choose another runtime for the planner."})
    if "You route one message" in system:
        return json.dumps({"route": "plan"})
    fields = json_after(system, CONTRACT_HEADER)
    if isinstance(fields, list) and fields:
        if "Server-owned review protocol" in system:
            output = json.dumps({f["id"]: field_value(f, gist) for f in fields}) if len(fields) > 1 else str(field_value(fields[0], gist))
            return json.dumps({"approved": True, "output": output, "feedback": ""})
        if len(fields) == 1 and fields[0].get("type") in ("text", "markdown", "html"):
            return str(field_value(fields[0], gist))
        return json.dumps({f["id"]: field_value(f, gist) for f in fields}, ensure_ascii=False)
    return f"(Python worker) You said: {gist}"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"awwo-python-worker/{VERSION}"

    def log_message(self, fmt, *args):  # keep the console quiet; errors are still raised
        pass

    def _authorized(self) -> bool:
        return not TOKEN or hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}")

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        if self.path == "/health":
            with LOCK:
                active = len(ACTIVE)
            return self._json(200, {"ready": True, "protocol": 1, "runtime": RUNTIME, "model": "py-echo", "models": models(),
                                    "tools": [], "maxConcurrency": 8, "activeRuns": active,
                                    "completionOptions": [], "sdkVersion": f"awwo-python-worker {VERSION}"})
        self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        if self.path.startswith("/internal/runs/"):
            run_id = urllib.parse.unquote(self.path[len("/internal/runs/"):])
            with LOCK:
                stop = ACTIVE.get(run_id)
            if stop:
                stop.set()
            return self._json(200, {"cancelled": bool(stop)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            body = self._body()
        except ValueError as error:
            return self._json(400, {"error": str(error)})
        if self.path == "/internal/completions":
            messages = (body.get("completion") or {}).get("messages") or []
            system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
            last = messages[-1].get("content", "") if messages else ""
            return self._json(200, {"completion": {"choices": [{"message": {"content": generate({"systemPrompt": system, "prompt": last})}}]}})
        if self.path != "/internal/runs":
            return self._json(404, {"error": "not found"})
        run_id = body.get("runId")
        if not isinstance(run_id, str) or not run_id or not isinstance(body.get("prompt"), str):
            return self._json(400, {"error": "runId and prompt are required"})
        if body.get("runtime") not in (None, "", RUNTIME):
            return self._json(422, {"error": f"this worker serves runtime {RUNTIME}"})
        if body.get("model") not in (None, "", "py-echo"):
            return self._json(422, {"error": f"unknown model {body.get('model')}"})
        stop = threading.Event()
        with LOCK:
            if run_id in ACTIVE:
                return self._json(409, {"error": "run already active"})
            ACTIVE[run_id] = stop
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            def send(event: dict) -> None:
                self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()

            text = generate(body)
            for start in range(0, len(text), 24):
                if stop.is_set():
                    return send({"type": "cancelled"})
                send({"type": "text_delta", "delta": text[start:start + 24]})
                time.sleep(0.01)
            send({"type": "cancelled"} if stop.is_set() else {"type": "completed", "text": text})
        except (BrokenPipeError, ConnectionResetError):
            pass  # the orchestrator went away; nothing left to tell it
        finally:
            with LOCK:
                ACTIVE.pop(run_id, None)


def orchestrator(method: str, path: str, body: dict | None = None) -> int:
    headers = {"Content-Type": "application/json"}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{REGISTER_URL}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except OSError as error:
        print(f"[python-worker] orchestrator unreachable: {error}", file=sys.stderr)
        return 0


def main() -> None:
    if HOST not in ("127.0.0.1", "::1", "localhost") and not TOKEN:
        sys.exit(f"[python-worker] refusing to bind {HOST} without AWWO_PY_WORKER_TOKEN")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{server.server_address[1]}"
    print(f"[python-worker] runtime \"{RUNTIME}\" on {url}", flush=True)
    if REGISTER_URL:
        entry = {"id": RUNTIME, "url": url, "label": "Python (stdlib demo)", **({"token": TOKEN} if TOKEN else {})}
        print(f"[python-worker] register with {REGISTER_URL}: HTTP {orchestrator('POST', '/api/runtimes', entry)}", flush=True)
        atexit.register(lambda: print(f"[python-worker] unregister: HTTP {orchestrator('DELETE', f'/api/runtimes/{RUNTIME}')}", flush=True))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
