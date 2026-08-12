process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isTypingFresh, shouldFlush, effectiveSettleMs } from './batchTiming.js';

const SETTLE = 5000;   // rolling window: flush 5s after the last message
const t0 = 1_000_000;

test('effectiveSettleMs grows +1s per message from a 5s base, capped at 20s', () => {
  const eff = (n: number) => effectiveSettleMs(n, 5000, 1000, 20000);
  assert.equal(eff(1), 5000);   // bubble 1 = 5s
  assert.equal(eff(2), 6000);   // bubble 2 = 6s
  assert.equal(eff(3), 7000);   // bubble 3 = 7s
  assert.equal(eff(16), 20000); // 5 + 15 = 20s
  assert.equal(eff(17), 20000); // capped
  assert.equal(eff(100), 20000);
  assert.equal(eff(0), 5000);   // defensive: treated as at least 1
});

test('lone message flushes after the settle window, not before', () => {
  const state = { lastActivityAt: t0 };
  assert.equal(shouldFlush(state, t0 + 4999, SETTLE), false);
  assert.equal(shouldFlush(state, t0 + 5000, SETTLE), true);
});

test('a new message RESETS the window to 5s (rolling, not accumulating)', () => {
  // A 2nd message bumped lastActivity to t0+4000; the window is now 5s from THAT, i.e. flush at t0+9000.
  const state = { lastActivityAt: t0 + 4000 };
  assert.equal(shouldFlush(state, t0 + 8000, SETTLE), false); // only 4000ms since the last message
  assert.equal(shouldFlush(state, t0 + 9000, SETTLE), true);  // 5000ms since the last message
});

test('no total-time ceiling — a long burst stays open as long as messages keep arriving <5s apart', () => {
  // Even 60s after the first message, if the LAST message was 2s ago, we do NOT flush yet.
  const state = { lastActivityAt: t0 + 60_000 };
  assert.equal(shouldFlush(state, t0 + 62_000, SETTLE), false); // 2s since last message -> keep waiting
  assert.equal(shouldFlush(state, t0 + 65_000, SETTLE), true);  // 5s quiet -> flush the whole burst
});

test('batching does NOT depend on the typing indicator (shouldFlush takes no typing input)', () => {
  const state = { lastActivityAt: t0 };
  assert.equal(shouldFlush(state, t0 + 5000, SETTLE), true);
});

// isTypingFresh is still used by the opt-in waitForUserQuiet send-pause (not by batching).
test('isTypingFresh: fresh only within the window after the last typing event', () => {
  assert.equal(isTypingFresh({ isTyping: true, at: t0 }, t0 + 1000, 1500), true);
  assert.equal(isTypingFresh({ isTyping: true, at: t0 }, t0 + 1600, 1500), false); // self-expired
  assert.equal(isTypingFresh({ isTyping: false, at: t0 }, t0 + 10, 1500), false);
  assert.equal(isTypingFresh(undefined, t0, 1500), false);
});
