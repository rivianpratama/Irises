"""irises-bridge — front hermes channels with Irises. Zero hermes source changes.

Install (both steps are hermes's own official mechanisms):
    cp -r bridge/hermes/irises-bridge ~/.hermes/plugins/
    hermes plugins enable irises-bridge   # = config.yaml  plugins: { enabled: [irises-bridge] }
Environment (set for the gateway process):
    IRISES_URL           where Irises runs           (default http://127.0.0.1:3000)
    IRISES_BRIDGE_TOKEN  shared secret = Irises's ENGINE_PUSH_TOKEN
    IRISES_FRONT         comma-separated fnmatch patterns over "<platform>:<chat_id>"
                         e.g. "telegram:*"  or  "whatsapp:+1555*,discord:123".
                         EMPTY = front nothing (default — hermes behaves normally).
    IRISES_BRIDGE_PORT   loopback listener for Irises's outbound sends (default 8655)
    IRISES_BRIDGE_FAIL   open (default: on bridge error hermes answers itself) | closed

How it works (verified against hermes source):
  * `pre_gateway_dispatch` fires for every non-internal inbound message on EVERY platform,
    before auth/sessions/agent (gateway/run.py). Returning {"action": "skip"} suppresses
    hermes's own reply entirely. The hook is called SYNCHRONOUSLY on the gateway event loop,
    so this handler only pattern-matches + enqueues — all I/O happens on worker threads.
  * Outbound: a loopback HTTP listener accepts {"platform","chat_id","text"} from Irises and
    delivers via gateway.adapters[Platform].send(...) — the same in-process call hermes's own
    webhook adapter uses, uniform across every current and future platform.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import queue
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("plugins.irises_bridge")

_FORWARD_Q: "queue.Queue[dict]" = queue.Queue(maxsize=1000)
# [gateway, loop] captured on the first fronted message; the outbound listener needs both.
_GW: list = [None, None]
_STARTED = threading.Event()


def _cfg(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _patterns() -> list[str]:
    return [p.strip().lower() for p in _cfg("IRISES_FRONT").split(",") if p.strip()]


def _fronted(platform: str, chat_id: str) -> bool:
    key = f"{platform}:{chat_id}".lower()
    return any(fnmatch.fnmatch(key, pat) for pat in _patterns())


# ── forward worker (inbound → Irises) ────────────────────────────────────────

def _forward_loop() -> None:
    base = _cfg("IRISES_URL", "http://127.0.0.1:3000").rstrip("/")
    token = _cfg("IRISES_BRIDGE_TOKEN")
    while True:
        payload = _FORWARD_Q.get()
        try:
            req = urllib.request.Request(
                f"{base}/api/bridge/inbound",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "x-bridge-token": token},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as res:
                res.read()
        except Exception as exc:  # noqa: BLE001 — forwarding is best-effort; hermes already skipped
            log.warning("irises-bridge: forward failed (message from %s:%s dropped): %s",
                        payload.get("platform"), payload.get("chat_id"), exc)


# ── outbound listener (Irises → hermes channels) ─────────────────────────────

class _SendHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        token = _cfg("IRISES_BRIDGE_TOKEN")
        if token and self.headers.get("x-bridge-token") != token:
            self._reply(403, {"error": "forbidden"})
            return
        if self.path != "/send":
            self._reply(404, {"error": "unknown path"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except Exception:  # noqa: BLE001
            self._reply(400, {"error": "invalid json"})
            return
        platform, chat_id, text = body.get("platform"), body.get("chat_id"), body.get("text")
        if not platform or not chat_id or not text:
            self._reply(400, {"error": "platform, chat_id, text required"})
            return
        gateway, loop = _GW
        if gateway is None or loop is None:
            self._reply(503, {"error": "gateway not captured yet (no fronted message seen since start)"})
            return
        try:
            from gateway.platforms.base import Platform  # re-exported from gateway.config; dynamic members cover plugin platforms
            adapter = gateway.adapters.get(Platform(platform))
            if adapter is None:
                self._reply(400, {"error": f"platform '{platform}' is not connected on this hermes"})
                return
            metadata = {"thread_id": body["thread_id"]} if body.get("thread_id") else None
            reply_to = str(body["reply_to_id"]) if body.get("reply_to_id") else None
            fut = asyncio.run_coroutine_threadsafe(
                adapter.send(str(chat_id), str(text), reply_to=reply_to, metadata=metadata), loop)
            fut.result(timeout=20)
            self._reply(200, {"ok": True})
        except Exception as exc:  # noqa: BLE001
            log.warning("irises-bridge: send to %s:%s failed: %s", platform, chat_id, exc)
            self._reply(502, {"error": str(exc)[:300]})

    def _reply(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:  # silence per-request stderr noise
        pass


def _start_workers() -> None:
    if _STARTED.is_set():
        return
    _STARTED.set()
    threading.Thread(target=_forward_loop, name="irises-bridge-forward", daemon=True).start()
    port = int(_cfg("IRISES_BRIDGE_PORT", "8655"))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), _SendHandler)
        threading.Thread(target=server.serve_forever, name="irises-bridge-send", daemon=True).start()
        log.info("irises-bridge: outbound listener on 127.0.0.1:%d", port)
    except OSError as exc:
        log.error("irises-bridge: could not bind outbound listener on %d: %s", port, exc)


# ── the hook ──────────────────────────────────────────────────────────────────

def on_inbound(event=None, gateway=None, session_store=None, **_kwargs):
    """pre_gateway_dispatch. MUST return fast — runs synchronously on the gateway loop."""
    fail_closed = _cfg("IRISES_BRIDGE_FAIL", "open").lower() == "closed"
    try:
        if event is None or getattr(event, "internal", False):
            return None
        src = event.source
        platform = getattr(getattr(src, "platform", None), "value", None) or str(getattr(src, "platform", ""))
        chat_id = str(getattr(src, "chat_id", "") or "")
        if not platform or not chat_id or not _fronted(platform, chat_id):
            return None  # not fronted → hermes handles it exactly as before

        # Capture the live gateway + loop for the outbound listener (idempotent).
        _GW[0] = gateway
        try:
            _GW[1] = asyncio.get_running_loop()
        except RuntimeError:
            pass
        _start_workers()

        payload = {
            "engine": "hermes",
            "platform": platform,
            "chat_id": chat_id,
            "sender_id": getattr(src, "user_id", None) or getattr(event, "user_id", None),
            "sender_name": getattr(event, "user_name", None),
            "chat_name": getattr(src, "chat_name", None),
            "text": getattr(event, "text", "") or "",
            "message_id": getattr(event, "message_id", None),
            "thread_id": getattr(src, "thread_id", None),
            "reply_to_id": getattr(event, "reply_to_message_id", None),
            # hermes normalizes chat_type to dm/group/channel/thread ("supergroup" kept defensively
            # for adapters that pass raw platform values through).
            "is_group": (getattr(src, "chat_type", "") or "").lower() in ("group", "supergroup", "channel", "thread"),
            "media": [
                {"path": url, "mimeType": (list(getattr(event, "media_types", []) or [])[i] if i < len(list(getattr(event, "media_types", []) or [])) else "application/octet-stream")}
                for i, url in enumerate(list(getattr(event, "media_urls", []) or []))
            ],
        }
        try:
            _FORWARD_Q.put_nowait(payload)
        except queue.Full:
            log.warning("irises-bridge: forward queue full — %s", "holding silence (fail=closed)" if fail_closed else "letting hermes answer (fail=open)")
            return {"action": "skip", "reason": "irises-bridge-overflow"} if fail_closed else None
        return {"action": "skip", "reason": "irises-bridge"}
    except Exception as exc:  # noqa: BLE001 — never let a bridge bug break hermes dispatch
        log.warning("irises-bridge: hook error: %s", exc)
        return {"action": "skip", "reason": "irises-bridge-error"} if fail_closed else None


def register(ctx) -> None:
    ctx.register_hook("pre_gateway_dispatch", on_inbound)
    log.info("irises-bridge registered (front: %s)", ", ".join(_patterns()) or "<nothing — set IRISES_FRONT>")
