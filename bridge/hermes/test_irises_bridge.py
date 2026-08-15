"""Unit tests for the hermes irises-bridge plugin — pure stdlib, no hermes needed.

Run from the repo root:
    python -m unittest discover bridge/hermes

Covers every piece with real logic: the IRISES_FRONT pattern matcher, the pure
decision helpers (auth, sharding, backoff, forward/let-hermes, send-result
classification, health window) and the on_inbound hook (fronting decision,
payload shaping, fail-open/closed). The gateway-facing halves (hook registration,
adapter send, the loopback listener) are exercised by the live smoke test in
docs/ENGINES.md — they are thin shells over the helpers tested here.
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
            mock.patch.object(bridge, "_QUEUES", [self.q]),
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
        with mock.patch.object(bridge, "_QUEUES", [full]):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
                self.assertEqual(bridge.on_inbound(event=_event(), gateway=None),
                                 {"action": "skip", "reason": "irises-bridge-overflow"})

    def test_unreachable_irises_hands_the_turn_back_to_hermes_when_fail_open(self):
        # True fail-open: enqueueing into a void while telling hermes to stay silent is silence.
        down = bridge._Health()
        down.note_fail()
        with mock.patch.object(bridge, "_HEALTH", down):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))
            self.assertTrue(self.q.empty(), "nothing is queued for an unreachable Irises")
            # fail=closed keeps the old always-skip: the operator chose silence over hermes's voice.
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
                self.assertEqual(bridge.on_inbound(event=_event(), gateway=None),
                                 {"action": "skip", "reason": "irises-bridge"})
                self.assertFalse(self.q.empty())


class AuthStatus(unittest.TestCase):
    def test_unset_token_refuses_every_send(self):
        # Fail closed, and say WHY — the listener still binds so Irises sees a readable 403
        # instead of an ECONNREFUSED that reads as "the plugin isn't installed".
        for configured in ("", "   ", None):
            status, body = bridge._auth_status(configured, "anything")
            self.assertEqual(status, 403)
            self.assertIn("IRISES_BRIDGE_TOKEN unset", body["error"])

    def test_mismatch_is_plain_forbidden(self):
        self.assertEqual(bridge._auth_status("secret", "nope"), (403, {"error": "forbidden"}))
        self.assertEqual(bridge._auth_status("secret", None), (403, {"error": "forbidden"}))

    def test_exact_match_authorizes(self):
        self.assertIsNone(bridge._auth_status("secret", "secret"))


class ShardIndex(unittest.TestCase):
    def test_same_chat_always_lands_on_the_same_shard(self):
        first = bridge._shard_index("telegram-chat-42", 4)
        for _ in range(5):
            self.assertEqual(bridge._shard_index("telegram-chat-42", 4), first)
        self.assertIn(first, range(4))

    def test_single_shard_and_int_ids(self):
        self.assertEqual(bridge._shard_index("anything", 1), 0)
        self.assertEqual(bridge._shard_index("x", 0), 0)
        self.assertEqual(bridge._shard_index(42, 4), bridge._shard_index("42", 4))

    def test_traffic_spreads_across_shards(self):
        seen = {bridge._shard_index(f"chat{i}", 4) for i in range(50)}
        self.assertEqual(seen, {0, 1, 2, 3})


class Backoff(unittest.TestCase):
    def test_two_step_backoff_clamped_at_the_ends(self):
        self.assertEqual(bridge._backoff_s(1), 0.5)
        self.assertEqual(bridge._backoff_s(2), 2.0)
        self.assertEqual(bridge._backoff_s(0), 0.5)
        self.assertEqual(bridge._backoff_s(9), 2.0)


class ForwardDecision(unittest.TestCase):
    def test_matrix(self):
        self.assertEqual(bridge._forward_decision(True, False), "forward")
        self.assertEqual(bridge._forward_decision(False, False), "let_hermes")
        self.assertEqual(bridge._forward_decision(True, True), "forward")
        self.assertEqual(bridge._forward_decision(False, True), "forward")


class ClassifySendResult(unittest.TestCase):
    def test_success_carries_the_message_id_back(self):
        ok = types.SimpleNamespace(success=True, message_id=77, error=None, retryable=False)
        self.assertEqual(bridge._classify_send_result(ok), (200, {"ok": True, "message_id": "77"}))

    def test_success_without_an_id_is_still_200(self):
        ok = types.SimpleNamespace(success=True, message_id=None)
        self.assertEqual(bridge._classify_send_result(ok), (200, {"ok": True, "message_id": None}))

    def test_success_false_is_a_502_not_a_200(self):
        # adapter.send REPORTS failure (success=False) without raising.
        bad = types.SimpleNamespace(success=False, message_id=None, error="chat not found", retryable=True)
        self.assertEqual(bridge._classify_send_result(bad),
                         (502, {"error": "chat not found", "retryable": True}))
        vague = types.SimpleNamespace(success=False, message_id=None, error=None)
        status, body = bridge._classify_send_result(vague)
        self.assertEqual(status, 502)
        self.assertIn("failed", body["error"])

    def test_missing_result_is_a_502(self):
        status, body = bridge._classify_send_result(None)
        self.assertEqual(status, 502)
        self.assertIn("no send result", body["error"])


class Healthy(unittest.TestCase):
    def test_unknown_counts_healthy(self):
        self.assertTrue(bridge._healthy(None, 1000.0))

    def test_inside_and_outside_the_window(self):
        self.assertTrue(bridge._healthy(1000.0, 1059.0, 60.0))
        self.assertTrue(bridge._healthy(1000.0, 1060.0, 60.0))
        self.assertFalse(bridge._healthy(1000.0, 1061.0, 60.0))

    def test_health_state_transitions(self):
        h = bridge._Health()
        self.assertTrue(h.is_healthy(now=100.0), "nothing tried yet")
        h.note_fail(now=100.0)
        self.assertFalse(h.is_healthy(now=100.0), "tried and never succeeded is known-down")
        h.note_ok(now=200.0)
        self.assertTrue(h.is_healthy(now=250.0))
        self.assertFalse(h.is_healthy(now=400.0), "a stale OK falls out of the window")


if __name__ == "__main__":
    unittest.main()
