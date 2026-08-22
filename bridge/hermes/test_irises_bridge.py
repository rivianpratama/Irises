"""Unit tests for the hermes irises-bridge plugin — pure stdlib, no hermes needed.

Run from the repo root:
    python -m unittest discover bridge/hermes

Covers every piece with real logic: the IRISES_FRONT pattern matcher, the pure
decision helpers (auth, sharding, backoff, forward/let-hermes, send-result
classification, health window, config-error statuses), the forward worker's
handling of a rejected POST, and the on_inbound hook (fronting decision, payload
shaping, fail-open/closed). The gateway-facing halves (hook registration, adapter
send, the loopback listener) are exercised by the live smoke test in
docs/ENGINES.md — they are thin shells over the helpers tested here.
"""
from __future__ import annotations

import importlib.util
import pathlib
import queue
import types
import unittest
import urllib.error
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
        with mock.patch.object(bridge, "_GW", [None, None]):
            bridge.on_inbound(event=_event(), gateway="THE-GATEWAY")
            self.assertEqual(bridge._GW[0], "THE-GATEWAY")

    def test_a_none_gateway_never_clobbers_a_live_capture(self):
        # hermes may call the hook without the kwarg (it defaults to None). An unconditional write
        # nulled out the watch thread's capture on the first fronted message, and every outbound send
        # then answered 503 "gateway not ready" — silence on a chat hermes was told to skip.
        with mock.patch.object(bridge, "_GW", ["THE-GATEWAY", "THE-LOOP"]):
            bridge.on_inbound(event=_event(), gateway=None)
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


class ListenerStartup(unittest.TestCase):
    """The listener is what carries Irises's REPLIES. A failure to bind it must never be permanent,
    and must never take the forward workers (or the hook) down with it."""

    def test_port_parse_never_raises(self):
        for raw, expect in (("8655", 8655), ("9001", 9001), ("", 8655), ("eight-six-five-five", 8655)):
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_PORT": raw}):
                self.assertEqual(bridge._port(), expect, raw)

    def test_a_failed_bind_leaves_the_listener_retryable(self):
        listening = __import__("threading").Event()
        with mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "ThreadingHTTPServer", side_effect=OSError("address in use")):
            self.assertFalse(bridge._start_listener())
            self.assertFalse(listening.is_set(), "a failed bind must not mark the listener up")

        # The port frees up; the next attempt lands and the flag sticks.
        started = []
        fake_thread = mock.Mock(start=lambda: started.append(1))
        with mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "ThreadingHTTPServer", return_value=mock.Mock()), \
             mock.patch.object(bridge.threading, "Thread", return_value=fake_thread):
            self.assertTrue(bridge._start_listener())
            self.assertTrue(listening.is_set())
            self.assertTrue(bridge._start_listener(), "already bound is a cheap no-op")
            self.assertEqual(len(started), 1, "and does not bind or spawn twice")

    def test_workers_start_once_but_the_bind_is_reattempted(self):
        started = __import__("threading").Event()
        listening = __import__("threading").Event()
        binds = []
        with mock.patch.object(bridge, "_STARTED", started), \
             mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "_start_listener", lambda: binds.append(1) or False), \
             mock.patch.object(bridge.threading, "Thread", return_value=mock.Mock(start=lambda: None)):
            bridge._start_workers()
            bridge._start_workers()
        self.assertEqual(len(binds), 2, "_STARTED gates the threads, not the bind")


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


class ConfigErrorStatuses(unittest.TestCase):
    """401/403/404 are the two misconfigurations the bridge can hit, and neither self-heals."""

    def test_status_is_read_off_an_http_error_and_absent_from_a_transport_one(self):
        http = urllib.error.HTTPError("http://irises/api/bridge/inbound", 403, "Forbidden", {}, None)
        self.assertEqual(bridge._forward_status(http), 403)
        self.assertIsNone(bridge._forward_status(urllib.error.URLError("connection refused")))
        self.assertIsNone(bridge._forward_status(TimeoutError()))

    def test_only_401_403_404_count_as_configuration(self):
        for status in (401, 403, 404):
            self.assertTrue(bridge._is_config_error(status), status)
        for status in (None, 200, 429, 500, 502, 503):
            self.assertFalse(bridge._is_config_error(status), status)

    def test_the_hint_names_the_actual_cause(self):
        for status in (401, 403):
            hint = bridge._config_error_hint(status)
            self.assertIn("IRISES_BRIDGE_TOKEN", hint)
            self.assertIn("ENGINE_PUSH_TOKEN", hint)
        self.assertIn("OPS_BACKEND", bridge._config_error_hint(404))


class ForwardLoop(unittest.TestCase):
    """What a failed forward writes to _HEALTH decides whether the NEXT fronted turn reaches Irises
    or goes back to hermes — this message is already lost either way (hermes was told to skip)."""

    class _Stop(Exception):
        """Ends the worker's `while True` once the queued payloads are drained."""

    class _Queue:
        def __init__(self, items, stop):
            self._items, self._stop = list(items), stop

        def get(self):
            if self._items:
                return self._items.pop(0)
            raise self._stop

    def _run(self, exc):
        """Drive one payload through _forward_loop with every POST failing as `exc`."""
        posts = []

        def boom(base, token, payload):
            posts.append(payload)
            raise exc

        health = bridge._Health()
        q = self._Queue([{"platform": "telegram", "chat_id": "42"}], self._Stop)
        with mock.patch.object(bridge, "_post_inbound", boom), \
             mock.patch.object(bridge, "_HEALTH", health), \
             mock.patch.object(bridge, "_backoff_s", lambda _a: 0), \
             self.assertLogs(bridge.log, level="ERROR") as logged, \
             self.assertRaises(self._Stop):
            bridge._forward_loop(q)
        return health, len(posts), "\n".join(logged.output)

    def test_a_403_is_loud_final_and_hands_the_chat_back_to_hermes(self):
        health, posts, logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 403, "Forbidden", {}, None))
        self.assertEqual(posts, 1, "a token mismatch is never retried")
        self.assertIn("HTTP 403", logged)
        self.assertIn("IRISES_BRIDGE_TOKEN", logged)
        self.assertIn("ENGINE_PUSH_TOKEN", logged)
        self.assertFalse(health.is_healthy(), "the verdict flips even though /health still answers")
        # …and the flipped verdict is what actually returns the chat to hermes.
        with mock.patch.object(bridge, "_HEALTH", health), \
             mock.patch.object(bridge, "_QUEUES", [queue.Queue(maxsize=10)]), \
             mock.patch.object(bridge, "_start_workers", lambda: None), \
             mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*"}, clear=False):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))

    def test_a_404_names_the_unmounted_route(self):
        _health, posts, logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 404, "Not Found", {}, None))
        self.assertEqual(posts, 1)
        self.assertIn("HTTP 404", logged)
        self.assertIn("OPS_BACKEND", logged)

    def test_a_transport_failure_still_gets_all_three_attempts(self):
        health, posts, logged = self._run(urllib.error.URLError("connection refused"))
        self.assertEqual(posts, bridge._FORWARD_ATTEMPTS, "a restart deserves its retries")
        self.assertIn("LOST", logged)
        self.assertFalse(health.is_healthy())

    def test_a_500_is_transport_shaped_and_is_retried(self):
        _health, posts, _logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 500, "Server Error", {}, None))
        self.assertEqual(posts, bridge._FORWARD_ATTEMPTS)


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

    def test_a_fail_newer_than_the_last_ok_beats_a_fresh_probe(self):
        # The 15s /health probe is unauthenticated and route-independent, so it kept answering 200
        # through a 403 storm and every note_fail() from the forward path was inert — each fronted
        # message lost with hermes already told to stay silent.
        h = bridge._Health()
        h.note_ok(now=100.0)
        self.assertTrue(h.is_healthy(now=101.0))
        h.note_fail(now=102.0)
        self.assertFalse(h.is_healthy(now=103.0), "a forward failure is not masked by a fresh probe")
        h.note_ok(now=104.0)
        self.assertTrue(h.is_healthy(now=105.0), "and a later success clears it again")


if __name__ == "__main__":
    unittest.main()
