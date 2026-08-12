"""Unit tests for the hermes irises-bridge plugin — pure stdlib, no hermes needed.

Run from the repo root:
    python -m unittest discover bridge/hermes

Covers the two pieces with real logic: the IRISES_FRONT pattern matcher and the
on_inbound hook (fronting decision, payload shaping, fail-open/closed). The
gateway-facing halves (hook registration, adapter send) are exercised by the
live smoke test in docs/ENGINES.md — they are one-line calls into hermes.
"""
from __future__ import annotations

import importlib.util
import pathlib
import queue
import types
import unittest
from unittest import mock

_PLUGIN = pathlib.Path(__file__).resolve().parent / "irises-bridge" / "__init__.py"
_spec = importlib.util.spec_from_file_location("irises_bridge_under_test", _PLUGIN)
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)


def _event(platform="telegram", chat_id="123", **over):
    """A stand-in for hermes's MessageEvent with just the attributes the hook reads."""
    source = types.SimpleNamespace(
        platform=types.SimpleNamespace(value=platform),
        chat_id=chat_id,
        thread_id=over.pop("thread_id", None),
        chat_type=over.pop("chat_type", "dm"),
        chat_name=over.pop("chat_name", None),
        user_id=over.pop("user_id", "u1"),
    )
    defaults = dict(
        internal=False,
        source=source,
        text="hello",
        message_id="m1",
        user_name="Riv",
        reply_to_message_id=None,
        media_urls=[],
        media_types=[],
    )
    defaults.update(over)
    return types.SimpleNamespace(**defaults)


class PatternMatcher(unittest.TestCase):
    def test_empty_front_fronts_nothing(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": ""}):
            self.assertFalse(bridge._fronted("telegram", "123"))

    def test_wildcards_and_multi_pattern(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*, whatsapp:+1555*"}):
            self.assertTrue(bridge._fronted("telegram", "anything"))
            self.assertTrue(bridge._fronted("whatsapp", "+15551234"))
            self.assertFalse(bridge._fronted("whatsapp", "+16660000"))
            self.assertFalse(bridge._fronted("discord", "123"))

    def test_matching_is_case_insensitive(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "Telegram:ABC*"}):
            self.assertTrue(bridge._fronted("telegram", "abc99"))


class OnInbound(unittest.TestCase):
    def setUp(self):
        # Fresh queue per test; never start the worker threads / loopback listener.
        self.q: "queue.Queue[dict]" = queue.Queue(maxsize=10)
        patches = [
            mock.patch.object(bridge, "_FORWARD_Q", self.q),
            mock.patch.object(bridge, "_start_workers", lambda: None),
            mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*"}, clear=False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_unfronted_platform_falls_through(self):
        self.assertIsNone(bridge.on_inbound(event=_event(platform="whatsapp"), gateway=None))
        self.assertTrue(self.q.empty())

    def test_internal_events_fall_through(self):
        self.assertIsNone(bridge.on_inbound(event=_event(internal=True), gateway=None))

    def test_fronted_message_skips_hermes_and_enqueues_payload(self):
        ev = _event(chat_id="42", text="what's the weather", chat_type="group", chat_name="eng crew",
                    media_urls=["/var/cache/a.jpg", "/var/cache/b.bin"], media_types=["image/jpeg"])
        result = bridge.on_inbound(event=ev, gateway="GW")
        self.assertEqual(result, {"action": "skip", "reason": "irises-bridge"})
        payload = self.q.get_nowait()
        self.assertEqual(payload["engine"], "hermes")
        self.assertEqual(payload["platform"], "telegram")
        self.assertEqual(payload["chat_id"], "42")
        self.assertEqual(payload["sender_id"], "u1")
        self.assertEqual(payload["sender_name"], "Riv")
        self.assertEqual(payload["chat_name"], "eng crew")
        self.assertEqual(payload["text"], "what's the weather")
        self.assertEqual(payload["message_id"], "m1")
        self.assertTrue(payload["is_group"])
        self.assertEqual(payload["media"], [
            {"path": "/var/cache/a.jpg", "mimeType": "image/jpeg"},
            {"path": "/var/cache/b.bin", "mimeType": "application/octet-stream"},
        ])

    def test_group_chat_types(self):
        # hermes normalizes chat_type to dm/group/channel/thread (base SessionSource).
        for chat_type, expect in (("dm", False), ("group", True), ("channel", True), ("thread", True)):
            bridge.on_inbound(event=_event(chat_type=chat_type), gateway=None)
            self.assertEqual(self.q.get_nowait()["is_group"], expect, chat_type)

    def test_gateway_captured_for_outbound_listener(self):
        bridge.on_inbound(event=_event(), gateway="THE-GATEWAY")
        self.assertEqual(bridge._GW[0], "THE-GATEWAY")

    def test_hook_error_fails_open_by_default(self):
        # An event whose .source access blows up exercises the outer try/except.
        class Exploding:
            internal = False
            @property
            def source(self):
                raise RuntimeError("boom")
        self.assertIsNone(bridge.on_inbound(event=Exploding(), gateway=None))

    def test_hook_error_fails_closed_when_asked(self):
        class Exploding:
            internal = False
            @property
            def source(self):
                raise RuntimeError("boom")
        with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
            self.assertEqual(bridge.on_inbound(event=Exploding(), gateway=None),
                             {"action": "skip", "reason": "irises-bridge-error"})

    def test_full_queue_fails_open_by_default_and_closed_on_request(self):
        full: "queue.Queue[dict]" = queue.Queue(maxsize=1)
        full.put_nowait({})
        with mock.patch.object(bridge, "_FORWARD_Q", full):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
                self.assertEqual(bridge.on_inbound(event=_event(), gateway=None),
                                 {"action": "skip", "reason": "irises-bridge-overflow"})


if __name__ == "__main__":
    unittest.main()
