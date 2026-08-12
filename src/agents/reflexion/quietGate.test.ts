// Run with: npm test   (TZ=UTC tsx --test)
// The daily skip-if-quiet decision (isQuietSinceLastDaily): what counts as "added material"
// before a daily Reflexion pass is allowed to spend Opus tokens. The load-bearing rule — a
// silent day (no inbound message, nothing researched) must NOT run, and a day where only
// Irises's OWN proactive outbound fired counts as silent. Plus isDormant, the harder gate that
// keeps an inactive-but-email-connected user at zero LLM cost.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuietSinceLastDaily, lastUserMessageAt, isDormant } from './client.js';
import { scopeHistoryToUser } from '../../memory/transcript.js';
import type { StoredMessage } from '../../db/types.js';

const DAILY = 1_000_000; // the last-completed-daily anchor for these cases
const before = DAILY - 5_000;
const after = DAILY + 5_000;

function msg(role: 'user' | 'assistant', at: number, content = 'x'): StoredMessage {
  return { role, content, at };
}

// ── lastUserMessageAt ────────────────────────────────────────────────────────

test('lastUserMessageAt returns the newest USER message, ignoring later assistant messages', () => {
  const history = [msg('user', after), msg('assistant', after + 1_000)];
  assert.equal(lastUserMessageAt(history), after);
});

test('lastUserMessageAt is 0 when the window holds no user messages', () => {
  assert.equal(lastUserMessageAt([msg('assistant', after), msg('assistant', after + 1)]), 0);
  assert.equal(lastUserMessageAt([]), 0);
});

// ── isDormant (the zero-cost guard for an email-connected user who never chats) ──

test('isDormant: a window with no inbound user message is dormant (overrides email activity)', () => {
  assert.equal(isDormant([]), true, 'empty window → dormant');
  assert.equal(isDormant([msg('assistant', after), msg('assistant', after + 1)]), true, 'assistant-only → dormant');
});

test('isDormant: any inbound message makes the user active, even an untimed one', () => {
  assert.equal(isDormant([msg('user', before)]), false, 'one inbound → active');
  assert.equal(isDormant([{ role: 'user', content: 'hey' } as StoredMessage]), false, 'inbound counts with no `at` (timestamp-robust)');
});

// ── isQuietSinceLastDaily ────────────────────────────────────────────────────

test('QUIET (skip) when nothing happened at all since the last daily pass', () => {
  assert.equal(isQuietSinceLastDaily({ history: [], lastDailyAt: DAILY, freshShortCount: 0 }), true);
});

test('QUIET (skip) when only stale (pre-anchor) user messages remain in the window', () => {
  const history = [msg('user', before)];
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 0 }), true);
});

test('QUIET (skip) on an outbound-only day — Irises pinged, the user never replied', () => {
  // The exact gap this fix closes: assistant messages after the anchor are NOT added material.
  const history = [msg('user', before), msg('assistant', after), msg('assistant', after + 2_000)];
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 0 }), true);
});

test('RUN when the user sent a message since the last daily pass', () => {
  const history = [msg('assistant', before), msg('user', after)];
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 0 }), false);
});

test('RUN on an outbound-only day IF it also produced short-term (surfaced email / research)', () => {
  const history = [msg('assistant', after)];
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 1 }), false);
});

test('first-ever pass (anchor 0): a real user message runs, pure silence skips', () => {
  assert.equal(isQuietSinceLastDaily({ history: [msg('user', 1)], lastDailyAt: 0, freshShortCount: 0 }), false);
  assert.equal(isQuietSinceLastDaily({ history: [], lastDailyAt: 0, freshShortCount: 0 }), true);
});

// ── Scoped quiet gate (cross-user isolation) ─────────────────────────────────
// The runner scopes the window to the run's handle BEFORE the quiet check, so another
// participant chatting in a shared/mis-bound thread is not "added material" for this user.

test('another participant\'s fresh message does NOT wake the gate for this handle', () => {
  const history = scopeHistoryToUser(
    [{ role: 'user' as const, content: 'yo', at: after, handle: '+15550009999' }],
    '+15550001111',
  );
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 0 }), true);
});

test('the user\'s OWN fresh message still wakes the gate after scoping', () => {
  const history = scopeHistoryToUser(
    [
      { role: 'user' as const, content: 'yo', at: after, handle: '+15550001111' },
      { role: 'user' as const, content: 'hey', at: after + 1, handle: '+15550009999' },
    ],
    '+15550001111',
  );
  assert.equal(isQuietSinceLastDaily({ history, lastDailyAt: DAILY, freshShortCount: 0 }), false);
});
