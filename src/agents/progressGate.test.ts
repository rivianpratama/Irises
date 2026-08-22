import test from 'node:test';
import assert from 'node:assert/strict';
import { type PingBudget, ProgressGate, runPingCycle } from './progressGate.js';

// The throttle law behind "waiting on Ops" reassurances: at most 1 mid-run update per run, fired no
// sooner than 5 minutes in and no closer than 5 minutes apart. A controllable clock lets us assert
// the timing exactly.
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('defaults encode the 5-min / max-1 law', () => {
  const c = clock();
  const gate = new ProgressGate({ now: c.now }); // all timing defaults
  c.advance(299_000);
  assert.equal(gate.allow('heartbeat'), false, 't=4:59 — still under the 5-min quiet window');
  c.advance(2_000); // t = 5:01
  assert.equal(gate.allow('heartbeat'), true, 't=5:01 — crossed 5 min, first ping allowed');
  assert.equal(gate.allow('another'), false, 'the default cap is 1 — no second update in the same run');
});

test('stays silent until the wait crosses quietMs (5 min)', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, now: c.now });
  assert.equal(gate.allow('heartbeat'), false, 't=0 — far too soon');
  c.advance(299_000);
  assert.equal(gate.allow('heartbeat'), false, 't=4:59 — still under 5 min');
  c.advance(2_000); // t = 5:01
  assert.equal(gate.allow('heartbeat'), true, 't=5:01 — crossed 5 min, first ping allowed');
});

test('fires at most once every gapMs (5 min) — never closer', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, maxPings: 5, now: c.now });
  c.advance(301_000);
  assert.equal(gate.allow('a'), true, 'first ping just past 5 min');
  c.advance(150_000); // only 2.5 min since the last ping
  assert.equal(gate.allow('b'), false, '2.5 min later — inside the 5-min window, suppressed');
  c.advance(150_000); // now 5 min since the last ping
  assert.equal(gate.allow('c'), true, '5 min later — allowed again');
});

test('caps total pings regardless of spacing', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 2, now: c.now });
  assert.equal(gate.allow('a'), true);
  assert.equal(gate.allow('b'), true);
  assert.equal(gate.allow('c'), false, 'third ping blocked by the maxPings backstop');
});

test('dedupes a repeat of the SAME milestone key within one run', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5, now: c.now });
  assert.equal(gate.allow('read_email'), true);
  assert.equal(gate.allow('read_email'), false, 'same milestone key — suppressed even with room left');
  assert.equal(gate.allow('read_url'), true, 'a different milestone still passes');
});

test('allow() reserves the slot synchronously (no double-fire in the voice window)', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, maxPings: 5, now: c.now });
  c.advance(301_000);
  // Two milestones landing in the same instant (before either voice call finishes): only one wins.
  assert.equal(gate.allow('heartbeat'), true);
  assert.equal(gate.allow('read_email'), false, 'second concurrent milestone is inside the gap and loses');
});

test('stop() freezes the gate on settle', () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5, now: c.now });
  assert.equal(gate.isStopped, false);
  gate.stop();
  assert.equal(gate.isStopped, true);
  assert.equal(gate.allow('a'), false, 'no pings once Ops has settled');
});

test('the first ping clears the gap even when quietMs < gapMs', () => {
  // Config where the quiet window ends before a full gap has elapsed from t=0.
  const c = clock();
  const gate = new ProgressGate({ quietMs: 30_000, gapMs: 300_000, maxPings: 5, now: c.now });
  c.advance(30_000); // just past quiet, but only 30s since start
  assert.equal(gate.allow('heartbeat'), true, 'first ping fires at quiet-end, not gated by the (unmet) gap');
});

test('PROD primary leg (quiet=gap=300s, cap=1) fires ZERO reassurances across its 4-min Ops window', () => {
  // Mirrors deploy defaults: the primary gate's quiet window is 5 min, but OPS_TASK_TIMEOUT_MS=240s
  // kills the primary run at 4 min — so the quiet window never even opens. The holding line stands
  // alone; a second leg gets its own fresh gate against the same shared budget.
  const c = clock();
  const gate = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, maxPings: 1, now: c.now });
  let allowed = 0;
  for (let elapsed = 10_000; elapsed <= 240_000; elapsed += 10_000) {
    c.advance(10_000);
    if (gate.allow(`milestone-${elapsed}`)) allowed++; // distinct keys so dedupe never masks the throttle
  }
  assert.equal(allowed, 0, 'no reassurance fires within the 4-min primary window at prod settings');
});

// ── Shared run-wide budget: the total mid-run update count is capped across ALL legs ────────────

test('a shared budget caps mid-run updates across two gates (primary + retry legs)', () => {
  // The budget is what makes the cap run-wide rather than per-leg: gate B is blocked even though its
  // OWN pingCount is still 0, because gate A already spent the one shared slot.
  const budget: PingBudget = { remaining: 1 };
  const c = clock();
  const primary = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 1, budget, now: c.now });
  const retry = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 1, budget, now: c.now });
  assert.equal(primary.allow('heartbeat'), true, 'primary spends the one shared slot');
  assert.equal(budget.remaining, 0, 'the shared budget is debited synchronously on the reserve');
  assert.equal(retry.allow('heartbeat-2'), false, 'the second gate is blocked by the shared budget despite its own count being 0');
});

test('a deduped or blocked ping never debits the shared budget', () => {
  const budget: PingBudget = { remaining: 1 };
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5, budget, now: c.now });
  assert.equal(gate.allow('read_email'), true);
  assert.equal(budget.remaining, 0, 'the one allowed ping spent the slot');
  assert.equal(gate.allow('read_email'), false, 'same key — deduped');
  assert.equal(gate.allow('read_url'), false, 'a fresh key, but the shared budget is now empty');
  assert.equal(budget.remaining, 0, 'neither the dedupe nor the budget-blocked call went negative');
});

test('two-leg shape: primary silent through its window, then a fresh gate spends the one slot', () => {
  // End-to-end mirror of runOpsAndFollowUp: one budget spans both legs.
  const budget: PingBudget = { remaining: 1 };
  const c = clock();
  // Primary leg: 5-min quiet, killed at the 4-min task timeout → never eligible.
  const primary = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, maxPings: 1, budget, now: c.now });
  let primaryPings = 0;
  for (let elapsed = 10_000; elapsed <= 240_000; elapsed += 10_000) {
    c.advance(10_000);
    if (primary.allow(`milestone-${elapsed}`)) primaryPings++;
  }
  assert.equal(primaryPings, 0, 'primary never pings before the 4-min timeout');
  primary.stop(); // primary leg frozen on timeout, budget still intact

  // Second leg: fresh gate, quiet 0 so its first beat lands immediately, same budget.
  const second = new ProgressGate({ quietMs: 0, gapMs: 300_000, maxPings: 1, budget, now: c.now });
  assert.equal(second.allow('progress'), true, 'the second leg spends the remaining slot');
  c.advance(300_000); // the heartbeat timer would fire here
  assert.equal(second.allow('heartbeat'), false, 'heartbeat suppressed — the one update was already spent');
});

// ── runPingCycle: the allow → voice → drop-if-settled → send ordering ──────────────────────────

test('runPingCycle: a suppressed ping spends no voice call and never sends', async () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 300_000, gapMs: 300_000, now: c.now }); // t=0: inside the quiet window
  let voiced = false;
  let sent = 0;
  await runPingCycle(gate, 'heartbeat', async () => { voiced = true; return 'x'; }, () => { sent++; });
  assert.equal(voiced, false, 'gate suppressed it before the model call');
  assert.equal(sent, 0);
});

test('runPingCycle: an allowed ping voices then sends', async () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, now: c.now });
  let sent = '';
  await runPingCycle(gate, 'heartbeat', async () => 'still on it', t => { sent = t; });
  assert.equal(sent, 'still on it');
});

test('runPingCycle: a ping whose voice resolves AFTER settle is dropped (no stale ping post-answer)', async () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, now: c.now });
  let sent = 0;
  // Ops settles mid-voice — the run finished while we were still composing the reassurance.
  const voice = async () => { gate.stop(); return 'stale still-digging'; };
  await runPingCycle(gate, 'heartbeat', voice, () => { sent++; });
  assert.equal(sent, 0, 'the answer is coming — the stale reassurance must not land after it');
});

test('runPingCycle: two milestones in the same instant yield exactly one send', async () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 120_000, maxPings: 5, now: c.now });
  let sent = 0;
  const voice = async () => 'on it';
  await Promise.all([
    runPingCycle(gate, 'a', voice, () => { sent++; }),
    runPingCycle(gate, 'b', voice, () => { sent++; }),
  ]);
  assert.equal(sent, 1, 'the synchronous reserve in allow() lets only the first of two concurrent pings through');
});

test('runPingCycle: a throwing voice never surfaces as a rejection and never sends', async () => {
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, now: c.now });
  let sent = 0;
  await runPingCycle(gate, 'heartbeat', async () => { throw new Error('provider down'); }, () => { sent++; });
  assert.equal(sent, 0, 'a hard voice failure just means no ping this cycle');
});

test('runPingCycle: a throwing send is swallowed — a floated ping can never take the run down', async () => {
  // Called exactly the way the orchestrator calls it: floated, and (for the heartbeat) from inside a
  // setTimeout with no caller at all. An unhandled rejection is FATAL in the real process
  // (diagnostics/errorLog.ts exits(1) on one), so an unguarded send-throw killed the VM mid-run —
  // taking the in-flight delegation, its deadline timer and the whole trace ring with it, which
  // reads downstream as the task hanging forever with nothing ever logged again.
  const c = clock();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, now: c.now });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    void runPingCycle(gate, 'heartbeat', async () => 'still on it', () => { throw new Error('mouth exploded'); });
    await new Promise<void>(r => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, 'a best-effort reassurance must never surface as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
