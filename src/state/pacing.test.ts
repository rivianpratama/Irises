process.env.TZ = 'UTC';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/pacing.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typingDelayMs, holdLoop, type PacingConfig, type HoldDeps } from './pacing.js';

// The shipped deploy/app.env baseline — the regression assertions below pin the retune.
const CFG: PacingConfig = { cpm: 800, minMs: 600, maxMs: 3000, firstBubbleMaxMs: 800, jitterPct: 0 };
const mid = () => 0.5; // rand=0.5 → zero jitter offset even when jitterPct > 0

// ── typingDelayMs ─────────────────────────────────────────────────────────────

test('a tiny bubble is floored at minMs', () => {
  assert.equal(typingDelayMs('ok', CFG, false, mid), 600);
});

test('a long bubble is capped at maxMs', () => {
  assert.equal(typingDelayMs('x'.repeat(500), CFG, false, mid), 3000);
});

test('a mid-length bubble scales linearly with chars/cpm', () => {
  // 20 chars at 800 cpm = 1500ms — between floor and cap, so unclamped
  assert.equal(typingDelayMs('x'.repeat(20), CFG, false, mid), 1500);
});

test('whitespace-only text counts as 1 char (floor applies, no NaN)', () => {
  assert.equal(typingDelayMs('   ', CFG, false, mid), 600);
});

test('REGRESSION: a 32-char bubble no longer waits 10s (old 190cpm/10s-cap defaults)', () => {
  // 32 chars was the old cap break-even: every real bubble hit the full 10 000ms.
  assert.ok(typingDelayMs('x'.repeat(32), CFG, false, mid) <= 3000);
});

test('the first bubble is additionally capped at firstBubbleMaxMs', () => {
  assert.equal(typingDelayMs('x'.repeat(500), CFG, true, mid), 800);
});

test('the first-bubble cap does NOT apply to later bubbles', () => {
  assert.equal(typingDelayMs('x'.repeat(500), CFG, false, mid), 3000);
});

test('jitter stays within ±jitterPct and is applied before the first-bubble cap', () => {
  const cfg: PacingConfig = { ...CFG, jitterPct: 15 };
  const base = 1500; // 20 chars
  assert.equal(typingDelayMs('x'.repeat(20), cfg, false, () => 0), Math.round(base * 0.85)); // rand=0 → -15%
  assert.equal(typingDelayMs('x'.repeat(20), cfg, false, () => 1), Math.round(base * 1.15)); // rand=1 → +15%
  // First bubble: jittered-up value still hard-bounded by firstBubbleMaxMs
  assert.equal(typingDelayMs('x'.repeat(20), cfg, true, () => 1), 800);
});

test('jitterPct=0 is fully deterministic (rand never consulted)', () => {
  const boom = () => { throw new Error('rand must not be called'); };
  assert.equal(typingDelayMs('x'.repeat(20), CFG, false, boom), 1500);
});

// ── holdLoop ──────────────────────────────────────────────────────────────────

// Simulated clock: sleep advances `now` instantly, so these tests run in microseconds.
function fakeDeps(overrides: Partial<HoldDeps> = {}) {
  let now = 0;
  let pings = 0;
  const deps: HoldDeps = {
    sleep: async (ms: number) => { now += ms; },
    ping: () => { pings++; },
    now: () => now,
    ...overrides,
  };
  return { deps, elapsed: () => now, pings: () => pings };
}

test('holdLoop waits exactly the budget and pings at start + each refresh', async () => {
  const { deps, elapsed, pings } = fakeDeps();
  await holdLoop(5000, 2000, false, deps);
  assert.equal(elapsed(), 5000);
  // start + after the 2000ms and 4000ms wakes (not after the final 1000ms chunk)
  assert.equal(pings(), 3);
});

test('holdLoop with finalPing adds exactly one freshness ping at the end', async () => {
  const { deps, pings } = fakeDeps();
  await holdLoop(5000, 2000, true, deps);
  assert.equal(pings(), 4);
});

test('holdLoop is deadline-based: oversleeps do not extend the hold', async () => {
  let now = 0;
  const { deps, pings } = fakeDeps({
    sleep: async (ms: number) => { now += ms + 1500; }, // every sleep overshoots
    now: () => now,
  });
  await holdLoop(6000, 2000, false, deps);
  assert.ok(now <= 6000 + 1500, `hold ran ${now}ms for a 6000ms budget`);
  assert.ok(pings() >= 1);
});

test('REGRESSION: a hung ping never blocks the hold (pings are fire-and-forget)', async () => {
  // The old holdTyping AWAITED each startTyping POST, stacking HTTP round trips on top of the
  // sleep budget — and a hung socket stalled the reply. ping is sync-void now; simulate the
  // worst case: a ping that kicks off a never-resolving promise. The hold must still complete.
  const { deps, elapsed } = fakeDeps({
    ping: () => { void new Promise(() => { /* never resolves */ }); },
  });
  await holdLoop(4000, 2000, true, deps);
  assert.equal(elapsed(), 4000);
});

test('holdLoop with a zero/negative budget sleeps never; pings only if finalPing', async () => {
  const a = fakeDeps();
  await holdLoop(0, 2000, false, a.deps);
  assert.equal(a.elapsed(), 0);
  assert.equal(a.pings(), 0);

  const b = fakeDeps();
  await holdLoop(-100, 2000, true, b.deps);
  assert.equal(b.elapsed(), 0);
  assert.equal(b.pings(), 1);
});
