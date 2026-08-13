// Run with: npm test   (TZ=UTC tsx --test)
// Thread-aware resolution of a tapped reply's target on the in-memory backend. The load-bearing case:
// a reply the transport collapses to the user's own thread ROOT resolves to that exchange (their
// message + Irises's answer bubbles), never silently to her latest sends. Plus the live-fetch fallback
// (Channel.getMessage) for a message that has aged out of the local index but still exists upstream.
process.env.TZ = 'UTC';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordSentBubble } from '../db/repositories/sentMessages.js';
import { recordInboundMessage } from '../db/repositories/inboundMessages.js';
import { resetStorageForTests } from '../db/sqlite.js';
import type { ResolvedReply } from './replyResolution.js'; // type-only — does not load the module at import time
import type { Channel, FetchedMessage } from '../channels/types.js';

// The live-fetch leg calls Channel.getMessage on the chat's transport. Production channels (web,
// bridge) don't implement it today, so a stub transport stands in for any future channel that does.
// `nextFetched` is what the live fetch returns; `getMessageCalls` lets local-hit tests assert the
// network leg was never reached. Registered under the bridge kind so `eng:` chatIds route to it.
const CHAT = 'eng:test:threadchat';
let nextFetched: FetchedMessage | null = null;
let getMessageCalls = 0;
const stubChannel: Channel = {
  kind: 'bridge',
  caps: { effects: false, threading: true, reactions: false, groupOps: false, contactCard: false },
  async sendMessage() { return {}; },
  async startTyping() { /* no-op */ },
  async stopTyping() { /* no-op */ },
  async markAsRead() { /* no-op */ },
  async getChat(chatId) { return { id: chatId, display_name: null, handles: [], is_group: false, service: 'bridge' }; },
  async sendReaction() { /* no-op */ },
  async getMessage() { getMessageCalls++; return nextFetched; },
};

let resolveTappedReply: (messageId: string, chatId: string) => Promise<ResolvedReply>;
before(async () => {
  ({ resolveTappedReply } = await import('./replyResolution.js'));
  const { registerChannel } = await import('../channels/registry.js');
  registerChannel(stubChannel);
});

beforeEach(() => {
  resetStorageForTests();
  nextFetched = null;
  getMessageCalls = 0;
});

// ── local resolution (no live fetch) ─────────────────────────────────────────

test('a tapped id that is one of Irises\'s bubbles → kind "assistant" with its text', async () => {
  await recordSentBubble(CHAT, 'bubble-1', 'the water heater is aging but still working');
  const r = await resolveTappedReply('bubble-1', CHAT);
  assert.deepEqual(r, { kind: 'assistant', text: 'the water heater is aging but still working' });
  assert.equal(getMessageCalls, 0); // local hit — never consults the channel
});

test('a tapped id that is the user\'s own thread root → kind "own-thread" with root + ordered answers', async () => {
  await recordInboundMessage(CHAT, 'user-q', 'when does the deposit clear?', '+15551234');
  await recordSentBubble(CHAT, 'a1', 'checking the timing on that now', 'user-q');
  await new Promise(res => setTimeout(res, 2));
  await recordSentBubble(CHAT, 'a2', 'the deposit clears on the 14th', 'user-q');
  const r = await resolveTappedReply('user-q', CHAT);
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.equal(r.rootText, 'when does the deposit clear?');
  assert.equal(r.rootSenderHandle, '+15551234');
  assert.deepEqual(r.assistantBubbles, ['checking the timing on that now', 'the deposit clears on the 14th']);
  assert.equal(r.viaLiveFetch, undefined); // local hit, not live
  assert.equal(getMessageCalls, 0);
});

test('own-thread with no recorded answer bubbles still resolves (assistantBubbles empty)', async () => {
  await recordInboundMessage(CHAT, 'user-q', 'their earlier question');
  const r = await resolveTappedReply('user-q', CHAT);
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.deepEqual(r.assistantBubbles, []);
  assert.equal(r.rootSenderHandle, undefined);
});

test('a Irises bubble wins over an inbound entry with the SAME id (most specific target)', async () => {
  await recordSentBubble(CHAT, 'dup', 'irises said this');
  await recordInboundMessage(CHAT, 'dup', 'user said this');
  const r = await resolveTappedReply('dup', CHAT);
  assert.deepEqual(r, { kind: 'assistant', text: 'irises said this' });
});

// ── live fallback (local double-miss) ────────────────────────────────────────

test('aged-out reply to one of Irises\'s OWN bubbles → live-fetched kind "assistant"', async () => {
  nextFetched = { id: 'old-1', chatId: CHAT, isFromMe: true, text: 'the deposit clears on the 14th', sentAtMs: Date.parse('2026-07-01T10:00:00Z') };
  const r = await resolveTappedReply('old-1', CHAT);
  assert.equal(r.kind, 'assistant');
  if (r.kind !== 'assistant') return;
  assert.equal(r.text, 'the deposit clears on the 14th');
  assert.equal(r.viaLiveFetch, true);
  assert.equal(r.sentAtMs, Date.parse('2026-07-01T10:00:00Z'));
  assert.equal(getMessageCalls, 1);
});

test('aged-out reply to the user\'s OWN old message → live-fetched kind "own-thread"', async () => {
  nextFetched = { id: 'old-q', chatId: CHAT, isFromMe: false, senderHandle: '+15551234', text: 'what did the inspection find?', sentAtMs: Date.parse('2026-07-01T09:00:00Z') };
  const r = await resolveTappedReply('old-q', CHAT);
  assert.equal(r.kind, 'own-thread');
  if (r.kind !== 'own-thread') return;
  assert.equal(r.rootText, 'what did the inspection find?');
  assert.equal(r.rootSenderHandle, '+15551234');
  assert.equal(r.viaLiveFetch, true);
  assert.deepEqual(r.assistantBubbles, []); // pre-feature thread: no anchors recorded
});

test('a live-fetched message from a DIFFERENT chat is refused → unresolved (anti-injection)', async () => {
  nextFetched = { id: 'x', chatId: 'eng:test:other', isFromMe: true, text: 'private text from another chat', sentAtMs: Date.parse('2026-07-01T10:00:00Z') };
  const r = await resolveTappedReply('x', CHAT); // requested CHAT, fetched a different chat → refused
  assert.deepEqual(r, { kind: 'unresolved' });
});

test('a truly gone message (channel returns null) → unresolved (honest fallback, never a silent latest-send miss)', async () => {
  nextFetched = null;
  const r = await resolveTappedReply('ghost-id', CHAT);
  assert.deepEqual(r, { kind: 'unresolved' });
  assert.equal(getMessageCalls, 1);
});

test('a media-only aged-out bubble resolves with the channel\'s placeholder text', async () => {
  nextFetched = { id: 'img-1', chatId: CHAT, isFromMe: true, text: '[a media attachment]', sentAtMs: Date.parse('2026-07-01T10:00:00Z') };
  const r = await resolveTappedReply('img-1', CHAT);
  assert.equal(r.kind, 'assistant');
  if (r.kind !== 'assistant') return;
  assert.equal(r.text, '[a media attachment]');
});

// ── channels with no live fetch (web / bridge without getMessage) ─────────────

test('a channel with no getMessage degrades to unresolved instead of guessing', async () => {
  // `web:` chatIds route to the web channel, which advertises no live message fetch (and isn't
  // registered in this test) — either way there's no getMessage, so resolution stays honest.
  const r = await resolveTappedReply('gone-id', 'web:debug');
  assert.deepEqual(r, { kind: 'unresolved' });
});
