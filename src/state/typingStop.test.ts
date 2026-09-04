process.env.TZ = 'UTC';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/typingStop.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypingLifecycle, type TypingLifecycleDeps } from './typingStop.js';

// Fake clock + fake timer queue: the whole point of the injected deps is that the trailing stop's
// 4.5-second window can be asserted in microseconds. Timers are captured, never run — a test fires
// the ones it wants with fireDue() so "did the trailing stop fire, and did it fire once" is a
// direct assertion instead of a sleep-and-hope.
function harness(trailingStopMs = 4500) {
  let now = 0;
  const starts: string[] = [];
  const stops: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
  const deps: TypingLifecycleDeps = {
    now: () => now,
    start: chatId => { starts.push(chatId); },
    stop: chatId => { stops.push(chatId); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false, fired: false }); return timers.length - 1; },
    clearTimeout: handle => { const t = timers[handle as number]; if (t) t.cancelled = true; },
  };
  const lifecycle = createTypingLifecycle(deps, { trailingStopMs });
  return {
    lifecycle, starts, stops, timers,
    advance: (ms: number) => { now += ms; },
    /** Run every scheduled timer that wasn't cancelled, in order, once. */
    fireDue: () => { for (const t of timers) { if (!t.cancelled && !t.fired) { t.fired = true; t.fn(); } } },
  };
}

test('release stops the dots immediately, exactly once', () => {
  const h = harness();
  h.lifecycle.noteStart('chat');
  h.lifecycle.release('chat');
  assert.deepEqual(h.stops, ['chat']);
  assert.equal(h.timers.length, 1, 'and schedules one trailing stop');
  assert.equal(h.timers[0].ms, 4500);
});

test('the trailing stop fires again when no start landed after the release', () => {
  // This is the whole bug: a fire-and-forget "start" issued before the final send can arrive at the
  // gateway AFTER the immediate stop, re-lighting Photon's stateful indicator with nothing to follow.
  const h = harness();
  h.lifecycle.noteStart('chat');
  h.lifecycle.release('chat');
  h.advance(4500);
  h.fireDue();
  assert.deepEqual(h.stops, ['chat', 'chat']);
});

test('a start after the release suppresses the trailing stop', () => {
  // A new turn asserted fresh dots in the meantime — killing them would blank the indicator on a
  // reply that is genuinely still coming.
  const h = harness();
  h.lifecycle.release('chat');
  h.advance(1000);
  h.lifecycle.noteStart('chat');
  h.advance(3500);
  h.fireDue();
  assert.deepEqual(h.stops, ['chat'], 'only the immediate stop');
  assert.deepEqual(h.starts, ['chat']);
});

test('a start at the same instant as the release still suppresses (start wins ties never)', () => {
  // lastStartAt <= stopAt means the start was already accounted for by this release, so the trailing
  // stop stays armed. Only a STRICTLY later start counts as a new turn.
  const h = harness();
  h.lifecycle.noteStart('chat');   // t=0
  h.lifecycle.release('chat');     // t=0 as well
  h.fireDue();
  assert.deepEqual(h.stops, ['chat', 'chat']);
});

test('a second release cancels the first pending trailing stop and reschedules', () => {
  const h = harness();
  h.lifecycle.release('chat');
  h.advance(1000);
  h.lifecycle.release('chat');
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[0].cancelled, true, 'the first trailing timer is cancelled, not left to double-fire');
  h.advance(4500);
  h.fireDue();
  // Two immediate stops (one per release) + exactly ONE trailing stop.
  assert.deepEqual(h.stops, ['chat', 'chat', 'chat']);
});

test('noteStart asserts the dots through the channel', () => {
  const h = harness();
  h.lifecycle.noteStart('chat');
  h.lifecycle.noteStart('chat');
  assert.deepEqual(h.starts, ['chat', 'chat']);
  assert.deepEqual(h.stops, []);
});

test('chats are independent: a start on B does not suppress A\'s trailing stop', () => {
  const h = harness();
  h.lifecycle.noteStart('a');
  h.lifecycle.release('a');
  h.advance(100);
  h.lifecycle.noteStart('b');
  h.advance(4400);
  h.fireDue();
  assert.deepEqual(h.stops, ['a', 'a']);
  assert.deepEqual(h.starts, ['a', 'b']);
});

test('a release with no prior start is still a valid stop (clears dots this process never lit)', () => {
  const h = harness();
  h.lifecycle.release('chat');
  h.fireDue();
  assert.deepEqual(h.stops, ['chat', 'chat']);
});

test('bookkeeping does not grow without bound: a fired trailing stop drops the chat', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    h.lifecycle.noteStart(`chat-${i}`);
    h.lifecycle.release(`chat-${i}`);
  }
  h.advance(4500);
  h.fireDue();
  assert.equal(h.stops.length, 200, 'every chat got its immediate + trailing stop');
  // Releasing them all again must schedule fresh timers rather than trip over cancelled handles.
  for (let i = 0; i < 100; i++) h.lifecycle.release(`chat-${i}`);
  assert.equal(h.stops.length, 300);
  assert.equal(h.timers.filter(t => !t.fired && !t.cancelled).length, 100);
});
