// The bridge inbound CONTRACT, tested as a pure unit — no HTTP, no express. The router's own
// tests (bridge.test.ts) are the byte-identity oracle for the shared coercions; these cover the
// parts express never lets through the door (a bare string / number / null body) plus the new
// rejections, the text cap, and the flag-off shape.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBridgeInbound,
  bridgeContractStrict,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_MAX_TEXT_CHARS,
  KNOWN_BRIDGE_FIELDS,
  coerceBridgeSendResult,
} from './contract.js';

const NOW = 1_700_000_000_000;

function strict(v: string | undefined, run: () => void): void {
  const prev = process.env.BRIDGE_CONTRACT_STRICT;
  if (v === undefined) delete process.env.BRIDGE_CONTRACT_STRICT;
  else process.env.BRIDGE_CONTRACT_STRICT = v;
  try { run(); } finally {
    if (prev === undefined) delete process.env.BRIDGE_CONTRACT_STRICT;
    else process.env.BRIDGE_CONTRACT_STRICT = prev;
  }
}

test('contract: the flag parses like every sibling gate — unset/empty is ON', () => {
  strict(undefined, () => assert.equal(bridgeContractStrict(), true));
  strict('', () => assert.equal(bridgeContractStrict(), true));
  strict('  ', () => assert.equal(bridgeContractStrict(), true));
  for (const on of ['true', '1', 'ON', 'yes']) strict(on, () => assert.equal(bridgeContractStrict(), true));
  for (const off of ['false', '0', 'off', 'no', 'nope']) strict(off, () => assert.equal(bridgeContractStrict(), false));
});

test('contract: a full payload parses into exactly the fields the door forwards', () => {
  const res = parseBridgeInbound({
    engine: 'hermes', platform: ' WhatsApp ', chat_id: 1555, sender_id: '+1555',
    sender_name: 'Riv', chat_name: 'Riv', text: 'what is the weather', message_id: 'm1',
    thread_id: 31, reply_to_id: 'root9', reply_to_text: '  here is the report  ',
    timestamp: (NOW - 30_000) / 1000, is_group: false, schema_version: 1,
    media: [{ url: 'https://x/p.jpg', mimeType: 'image/jpeg' }],
  }, NOW);
  assert.ok(res.ok);
  assert.deepEqual(res.ignoredFields, []);
  assert.deepEqual(res.value, {
    engine: 'hermes',
    platform: 'whatsapp',
    rawChatId: '1555',
    chatId: 'eng:whatsapp:1555',
    from: 'eng:whatsapp:+1555',
    text: 'what is the weather',
    messageId: 'm1',
    hasPlatformMessageId: true,
    media: { images: [{ url: 'https://x/p.jpg', mimeType: 'image/jpeg', filename: undefined }], audio: [], video: [], docs: [] },
    mediaCount: 1,
    replyTo: { message_id: 'root9', content: '  here is the report  ' },
    receivedAt: NOW - 30_000,
    isGroup: false,
    chatName: 'Riv',
    threadId: '31',
    schemaVersion: 1,
    truncated: false,
  });
});

test('contract: the required trio still governs, and its message is unchanged', () => {
  for (const body of [
    { platform: 'whatsapp', text: 'yo' },
    { platform: 'whatsapp', chat_id: '+1555' },
    { platform: 'whatsapp', chat_id: '+1555', text: '   ' },
    { chat_id: '+1555', text: 'yo' },
  ]) {
    const res = parseBridgeInbound(body, NOW);
    assert.equal(res.ok, false);
    assert.ok(!res.ok);
    assert.equal(res.error, 'platform, chat_id, and text (or media) are required');
    assert.equal(res.field, 'platform|chat_id|text');
  }
});

test('contract: a body express would never hand the router is rejected as `body`', () => {
  for (const body of [[], 'x', null, 42, undefined]) {
    const res = parseBridgeInbound(body, NOW);
    assert.ok(!res.ok, `${JSON.stringify(body)} must reject`);
    assert.equal(res.field, 'body');
  }
  // …and the same bodies degrade to today's required-trio 400 when the gate is off.
  strict('off', () => {
    for (const body of [[], 'x', null, 42, undefined]) {
      const res = parseBridgeInbound(body, NOW);
      assert.ok(!res.ok);
      assert.equal(res.field, 'platform|chat_id|text');
    }
  });
});

test('contract: an unknown MAJOR schema_version is refused; absent means 1, a minor bump rides', () => {
  const bad = parseBridgeInbound({ platform: 'whatsapp', chat_id: '+1', text: 'hi', schema_version: 2 }, NOW);
  assert.ok(!bad.ok);
  assert.equal(bad.field, 'schema_version');
  assert.match(bad.error, /schema_version/);

  const junk = parseBridgeInbound({ platform: 'whatsapp', chat_id: '+1', text: 'hi', schema_version: 'nope' }, NOW);
  assert.ok(!junk.ok);
  assert.equal(junk.field, 'schema_version');

  const absent = parseBridgeInbound({ platform: 'whatsapp', chat_id: '+1', text: 'hi' }, NOW);
  assert.ok(absent.ok);
  assert.equal(absent.value.schemaVersion, BRIDGE_SCHEMA_VERSION);

  const minor = parseBridgeInbound({ platform: 'whatsapp', chat_id: '+1', text: 'hi', schema_version: 1.4 }, NOW);
  assert.ok(minor.ok, 'a minor bump is a compatible sender, not a rejection');

  // Off: an unknown major is waved through exactly as it was before the contract existed.
  strict('off', () => {
    const res = parseBridgeInbound({ platform: 'whatsapp', chat_id: '+1', text: 'hi', schema_version: 9 }, NOW);
    assert.ok(res.ok);
    assert.equal(res.value.schemaVersion, 9);
  });
});

test('contract: an over-long text is capped and flagged, and the cap cannot turn a 202 into a 400', () => {
  const long = 'z'.repeat(5000);
  const res = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: long }, NOW);
  assert.ok(res.ok);
  assert.equal(res.value.text.length, BRIDGE_MAX_TEXT_CHARS);
  assert.equal(res.value.truncated, true);

  // Whitespace-only text still fails the trio rather than being capped into acceptance.
  const blank = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: ' '.repeat(5000) }, NOW);
  assert.ok(!blank.ok);
  assert.equal(blank.field, 'platform|chat_id|text');

  strict('off', () => {
    const off = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: long }, NOW);
    assert.ok(off.ok);
    assert.equal(off.value.text.length, 5000, 'no cap when the gate is off');
    assert.equal(off.value.truncated, false);
  });
});

test('contract: an unknown MINOR field is accepted and listed, never a rejection', () => {
  const res = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: 'hi', vibe: 'sunny', extra: 1 }, NOW);
  assert.ok(res.ok);
  assert.deepEqual(res.ignoredFields, ['vibe', 'extra']);
  assert.ok(!KNOWN_BRIDGE_FIELDS.has('vibe'));
  for (const known of ['engine', 'platform', 'chat_id', 'sender_id', 'sender_name', 'chat_name', 'text',
    'message_id', 'thread_id', 'reply_to_id', 'reply_to_text', 'timestamp', 'is_group', 'media', 'schema_version']) {
    assert.ok(KNOWN_BRIDGE_FIELDS.has(known), `${known} is part of v1`);
  }

  strict('off', () => {
    const off = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: 'hi', vibe: 'sunny' }, NOW);
    assert.ok(off.ok);
    assert.deepEqual(off.ignoredFields, [], 'nothing is inspected when the gate is off');
  });
});

test('contract: with the gate off the parsed value is the pre-refactor field set, byte for byte', () => {
  strict('off', () => {
    const res = parseBridgeInbound({
      platform: 'Telegram', chat_id: -777, text: 'in the topic', thread_id: 31,
      is_group: true, chat_name: 'forum', message_id: 42, timestamp: 'garbage',
      reply_to_text: '   ', schema_version: 9, vibe: 'sunny',
    }, NOW);
    assert.ok(res.ok);
    assert.deepEqual(res.value, {
      engine: undefined,
      platform: 'telegram',
      rawChatId: '-777',
      chatId: 'eng:telegram:-777',
      from: 'eng:telegram:-777',
      text: 'in the topic',
      messageId: '42',
      hasPlatformMessageId: true,
      media: { images: [], audio: [], video: [], docs: [] },
      mediaCount: 0,
      replyTo: undefined,
      receivedAt: undefined,
      isGroup: true,
      chatName: 'forum',
      threadId: '31',
      schemaVersion: 9,
      truncated: false,
    });
  });
});

test('contract: a media field that is not an array is empty, not a 500', () => {
  // mapBridgeMedia for-of's the list, so a scalar here used to throw a TypeError out of the route
  // handler. The turn now stands or falls on its text, like any other media-less turn.
  const res = parseBridgeInbound({ platform: 'signal', chat_id: '+1', text: 'hi', media: 42 }, NOW);
  assert.ok(res.ok);
  assert.equal(res.value.mediaCount, 0);
  assert.deepEqual(res.value.media, { images: [], audio: [], video: [], docs: [] });
  const empty = parseBridgeInbound({ platform: 'signal', chat_id: '+1', media: 42 }, NOW);
  assert.ok(!empty.ok);
  assert.equal(empty.field, 'platform|chat_id|text');
});

test('coerceBridgeSendResult: ids stringify, everything unreadable leaves the key undefined', () => {
  assert.deepEqual(coerceBridgeSendResult({ ok: true, message_id: '77' }), { messageId: '77' });
  assert.deepEqual(coerceBridgeSendResult({ ok: true, message_id: 88 }), { messageId: '88' });
  assert.deepEqual(coerceBridgeSendResult({ ok: true }), { messageId: undefined });
  // A body that parsed to something that isn't an object at all (an older build, a proxy page):
  // the message is already sent, so this is a lost tapped-reply id, never a failure.
  for (const junk of ['not json at all', null, 42, undefined, []]) {
    assert.deepEqual(coerceBridgeSendResult(junk), { messageId: undefined });
  }
});

test('contract: a quote with no id gets a synthetic id, derived from the parse clock', () => {
  const res = parseBridgeInbound({ platform: 'imessage', chat_id: '+1', text: 'yeah', reply_to_text: 'the earlier one' }, NOW);
  assert.ok(res.ok);
  assert.equal(res.value.replyTo?.content, 'the earlier one');
  assert.equal(res.value.replyTo?.message_id, `eng-quote-${NOW.toString(36)}`);
  // No message_id at all → the synthetic inbound id, from the same clock, and flagged as such so
  // idempotency never claims a key that changes every request.
  assert.equal(res.value.messageId, `eng-in-${NOW.toString(36)}`);
  assert.equal(res.value.hasPlatformMessageId, false);
});

// ── the shared fixture ────────────────────────────────────────────────────────
// bridge/contract-fixtures/inbound-v1.json is the ONE written description of a v1 payload, and
// BOTH sides of the wire read it: this file runs every case through the parser, and the hermes
// plugin's own suite (bridge/hermes/test_irises_bridge.py::test_payload_matches_shared_fixture)
// checks the payload it builds against the same field list. A name that drifts on one side and
// not the other now fails a test instead of silencing a chat — the incident-06889fa class.

interface FixtureCase {
  name: string;
  body: unknown;
  expect: { ok: boolean; field?: string; ignoredFields?: string[]; value?: Record<string, unknown> };
}
interface Fixture {
  now_ms: number;
  schema_version: number;
  known_fields: string[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../bridge/contract-fixtures/inbound-v1.json', import.meta.url), 'utf8'),
) as Fixture;

test('contract: the shared fixture names exactly the fields this door knows', () => {
  assert.equal(fixture.schema_version, BRIDGE_SCHEMA_VERSION);
  assert.deepEqual([...fixture.known_fields].sort(), [...KNOWN_BRIDGE_FIELDS].sort());
});

test('contract: every shared fixture case parses the way the fixture says it does', () => {
  assert.ok(fixture.cases.length >= 8, 'the fixture should carry the whole shape of the contract');
  for (const c of fixture.cases) {
    const res = parseBridgeInbound(c.body, fixture.now_ms);
    assert.equal(res.ok, c.expect.ok, c.name);
    if (!res.ok) {
      assert.equal(res.field, c.expect.field, c.name);
      continue;
    }
    if (c.expect.ignoredFields) assert.deepEqual(res.ignoredFields, c.expect.ignoredFields, c.name);
    for (const [k, want] of Object.entries(c.expect.value ?? {})) {
      assert.deepEqual((res.value as unknown as Record<string, unknown>)[k], want, `${c.name} → ${k}`);
    }
  }
});

test('contract: the openclaw plugin sends only fields this door knows, and forwards before it claims', () => {
  // The OpenClaw plugin is TypeScript but lives outside src/ and imports openclaw's own plugin SDK,
  // which is not a dependency here — so it cannot be imported and run by this suite the way the
  // hermes plugin is run by its own. Reading its source is how the shared contract reaches it at
  // all (the trick engineDiscovery.test.ts uses on models.ts), and it pins the two things a silent
  // forward would break: the payload's field names, and the fire-and-forget ordering.
  const src = readFileSync(new URL('../../../bridge/openclaw/irises-bridge/index.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const payload = {');
  assert.ok(start > 0, 'the plugin still builds one payload literal');
  const block = src.slice(start, src.indexOf('};', start));
  const keys = [...block.matchAll(/^\s{2,}([a-z_]+):/gm)].map(m => m[1]);
  assert.ok(keys.length >= 10, 'payload keys were found');
  for (const k of keys) assert.ok(KNOWN_BRIDGE_FIELDS.has(k), `openclaw sends an unknown field: ${k}`);
  assert.match(src, new RegExp(`const SCHEMA_VERSION = ${BRIDGE_SCHEMA_VERSION};`));
  assert.match(block, /schema_version:\s*SCHEMA_VERSION\b/);
  // Claiming the turn cannot move behind the forward without an OpenClaw engine change (see the
  // file header) — but the forward must be STARTED before the claim returns, or the retries would
  // be running behind a handler the engine has already finished with.
  const forwardAt = src.indexOf('void forwardInbound(');
  assert.ok(forwardAt > 0, 'the forward is still started, not awaited');
  assert.ok(src.indexOf('return { handled: true }') > forwardAt);
});
