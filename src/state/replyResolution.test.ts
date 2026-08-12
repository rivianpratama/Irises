// Run with: npm test   (TZ=UTC tsx --test)
// Thread-aware resolution of a tapped reply's target on the in-memory backend. The load-bearing case:
// a reply the transport collapses to the user's own thread ROOT resolves to that exchange (their
// message + Irises's answer bubbles), never silently to her latest sends. Plus the live-fetch fallback
// (Channel.getMessage) for a message that has aged out of the local index but still exists upstream.
process.env.TZ = 'UTC';
process.env.LINQ_API_TOKEN = 'test-token'; // set BEFORE linq/client.js binds API_TOKEN (loaded via the dynamic import below)

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { recordSentBubble } from '../db/repositories/sentMessages.js';
import { recordInboundMessage } from '../db/repositories/inboundMessages.js';
import { mem } from '../db/memory.js';
import type { ResolvedReply } from './replyResolution.js'; // type-only — does not load the module at import time

// Dynamic imports so linq/client.js binds the token set above (a static import would hoist above it).
let resolveTappedReply: (messageId: string, chatId: string) => Promise<ResolvedReply>;
before(async () => {
  ({ resolveTappedReply } = await import('./replyResolution.js'));
  // Bare chatIds resolve to the linq channel; register it so the live-fetch leg has a transport.
  const [{ registerChannel }, { linqChannel }] = await Promise.all([
    import('../channels/registry.js'),
    import('../channels/linq/index.js'),
  ]);
  registerChannel(linqChannel);
});

function clearAll(): void {
  mem.sentMessages.clear();
  mem.inboundMessages.clear();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function stubFetch(impl: () => Any) {
  const orig = globalThis.fetch;
  (globalThis as Any).fetch = async () => impl();
  return () => { globalThis.fetch = orig; };
}
const msgResp = (body: unknown): Any => ({ ok: true, status: 200, json: async () => body });
const notOk = (status = 404): Any => ({ ok: false, status, json: async () => ({}) });

// ── local resolution (no live fetch) ─────────────────────────────────────────

test('a tapped id that is one of Irises\'s bubbles → kind "assistant" with its text', async () => {
  clearAll();
  await recordSentBubble('chat-a', 'bubble-1', 'the water heater is aging but still working');
  const restore = stubFetch(() => { throw new Error('local hit must not call the network'); });
  const r = await resolveTappedReply('bubble-1', 'chat-a');
  restore();
  assert.deepEqual(r, { kind: 'assistant', text: 'the water heater is aging but still working' });
});

test('a tapped id that is the user\'s own thread root → kind "own-thread" with root + ordered answers', async () => {
  clearAll();
  await recordInboundMessage('chat-a', 'user-q', 'when does the deposit clear?', '+15551234');
  await recordSentBubble('chat-a', 'a1', 'checking the timing on that now', 'user-q');
  await new Promise(res => setTimeout(res, 2));
  await recordSentBubble('chat-a', 'a2', 'the deposit clears on the 14th', 'user-q');
  const restore = stubFetch(() => { throw new Error('local hit must not call the network'); });
  const r = await resolveTappedReply('user-q', 'chat-a');
  restore();
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.equal(r.rootText, 'when does the deposit clear?');
  assert.equal(r.rootSenderHandle, '+15551234');
  assert.deepEqual(r.assistantBubbles, ['checking the timing on that now', 'the deposit clears on the 14th']);
  assert.equal(r.viaLiveFetch, undefined); // local hit, not live
});

test('own-thread with no recorded answer bubbles still resolves (assistantBubbles empty)', async () => {
  clearAll();
  await recordInboundMessage('chat-a', 'user-q', 'their earlier question');
  const restore = stubFetch(() => { throw new Error('local hit must not call the network'); });
  const r = await resolveTappedReply('user-q', 'chat-a');
  restore();
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.deepEqual(r.assistantBubbles, []);
  assert.equal(r.rootSenderHandle, undefined);
});

test('a Irises bubble wins over an inbound entry with the SAME id (most specific target)', async () => {
  clearAll();
  await recordSentBubble('chat-a', 'dup', 'irises said this');
  await recordInboundMessage('chat-a', 'dup', 'user said this');
  const r = await resolveTappedReply('dup', 'chat-a');
  assert.deepEqual(r, { kind: 'assistant', text: 'irises said this' });
});

// ── live fallback (local double-miss) ────────────────────────────────────────

test('aged-out reply to one of Irises\'s OWN bubbles → live-fetched kind "assistant"', async () => {
  clearAll();
  const restore = stubFetch(() => msgResp({
    id: 'old-1', chat_id: 'chat-a', is_from_me: true,
    parts: [{ type: 'text', value: 'the deposit clears on the 14th' }],
    reply_to: null, created_at: '2026-07-01T10:00:00Z',
  }));
  const r = await resolveTappedReply('old-1', 'chat-a');
  restore();
  assert.equal(r.kind, 'assistant');
  if (r.kind !== 'assistant') return;
  assert.equal(r.text, 'the deposit clears on the 14th');
  assert.equal(r.viaLiveFetch, true);
  assert.equal(r.sentAtMs, Date.parse('2026-07-01T10:00:00Z'));
});

test('aged-out reply to the user\'s OWN old message → live-fetched kind "own-thread"', async () => {
  clearAll();
  const restore = stubFetch(() => msgResp({
    id: 'old-q', chat_id: 'chat-a', is_from_me: false, from_handle: { handle: '+15551234' },
    parts: [{ type: 'text', value: 'what did the inspection find?' }],
    reply_to: null, created_at: '2026-07-01T09:00:00Z',
  }));
  const r = await resolveTappedReply('old-q', 'chat-a');
  restore();
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.equal(r.rootText, 'what did the inspection find?');
  assert.equal(r.rootSenderHandle, '+15551234');
  assert.equal(r.viaLiveFetch, true);
  assert.deepEqual(r.assistantBubbles, []); // pre-feature thread: no anchors recorded
});

test('a live-fetched message from a DIFFERENT chat is refused → unresolved (anti-injection)', async () => {
  clearAll();
  const restore = stubFetch(() => msgResp({
    id: 'x', chat_id: 'chat-OTHER', is_from_me: true,
    parts: [{ type: 'text', value: 'private text from another chat' }], created_at: '2026-07-01T10:00:00Z',
  }));
  const r = await resolveTappedReply('x', 'chat-a');
  restore();
  assert.deepEqual(r, { kind: 'unresolved' });
});

test('a truly gone message (upstream 404) → unresolved (honest fallback, never a silent latest-send miss)', async () => {
  clearAll();
  const restore = stubFetch(() => notOk(404));
  const r = await resolveTappedReply('ghost-id', 'chat-a');
  restore();
  assert.deepEqual(r, { kind: 'unresolved' });
});

test('a media-only aged-out bubble resolves with a placeholder, not empty text', async () => {
  clearAll();
  const restore = stubFetch(() => msgResp({
    id: 'img-1', chat_id: 'chat-a', is_from_me: true, parts: [{ type: 'media' }], created_at: '2026-07-01T10:00:00Z',
  }));
  const r = await resolveTappedReply('img-1', 'chat-a');
  restore();
  assert.equal(r.kind, 'assistant');
  if (r.kind !== 'assistant') return;
  assert.equal(r.text, '[a media attachment]');
});

// ── channels with no live fetch (web / telegram) ─────────────────────────────

test('a channel with no getMessage degrades to unresolved instead of guessing', async () => {
  clearAll();
  const restore = stubFetch(() => { throw new Error('a channel without getMessage must never hit the network'); });
  // `web:` prefixed chatIds route to the web channel, which advertises no live message fetch.
  const r = await resolveTappedReply('gone-id', 'web:debug');
  restore();
  assert.deepEqual(r, { kind: 'unresolved' });
});
