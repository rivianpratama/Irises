// Seam tests: dispatch resolution, the runTask contract (debrief/sink/fallback shapes), and
// failure→OpsFailureCause mapping — all with stubbed backends via resetEngineBackendCache (DI).

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetEngineBackendCache, getEngineBackend, withEngineSlot, engineSlotState, runViaEngine, computeEngineTimeoutMs, computeEngineQueueWaitMs, standardLegBudgetMs, browserLegBudgetMs, BROWSER_LEG_BUDGET_MS, EngineRunError, EngineUnavailableError, type EngineBackend } from './engineBackend.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import { runTask, buildTaskPrompt, looksLikeMiss } from './client.js';
import { OpenClawBackend } from './openclawBackend.js';
import {
  markOpsStart, requestOpsSteer, getOpsEngineRun, takePendingSteers, __resetOpsCoordination,
} from '../../state/opsCoordination.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask, OpsDebrief, OpsDebriefSink } from '../types.js';

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'web_research',
    request: 'find the thing', createdAt: Date.now(), media: emptyMedia(), ...over,
  };
}

function stub(run: EngineBackend['runTask']): EngineBackend {
  return {
    name: 'hermes', runTask: run,
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
}

test('OPS_BACKEND unset → no engine; unknown value → no engine', () => {
  resetEngineBackendCache(undefined);
  const prev = process.env.OPS_BACKEND;
  try {
    delete process.env.OPS_BACKEND;
    assert.equal(getEngineBackend(), null);
    resetEngineBackendCache(undefined);
    process.env.OPS_BACKEND = 'skynet';
    assert.equal(getEngineBackend(), null);
  } finally {
    if (prev === undefined) delete process.env.OPS_BACKEND; else process.env.OPS_BACKEND = prev;
    resetEngineBackendCache(undefined);
  }
});

test('getEngineBackend: a null answer is NOT cached — OPS_BACKEND set later still resolves', () => {
  resetEngineBackendCache(undefined);
  const prev = process.env.OPS_BACKEND;
  try {
    delete process.env.OPS_BACKEND;
    assert.equal(getEngineBackend(), null);
    // Caching the null pinned deep work offline for the whole process whenever anything asked
    // before the env was loaded.
    process.env.OPS_BACKEND = 'hermes';
    assert.equal(getEngineBackend()?.name, 'hermes');
  } finally {
    if (prev === undefined) delete process.env.OPS_BACKEND; else process.env.OPS_BACKEND = prev;
    resetEngineBackendCache(undefined);
  }
});

test('computeEngineTimeoutMs: default, explicit override, and the small-orchestrator clamp', () => {
  assert.equal(computeEngineTimeoutMs({}), 225_000, '4min orchestrator default − 15s');
  // The operator's own number is taken as written, in both directions.
  assert.equal(computeEngineTimeoutMs({ ENGINE_TIMEOUT_MS: '9000' }), 9_000);
  assert.equal(computeEngineTimeoutMs({ ENGINE_TIMEOUT_MS: '600000', OPS_TASK_TIMEOUT_MS: '30000' }), 600_000);
  assert.equal(computeEngineTimeoutMs({ ENGINE_TIMEOUT_MS: 'nonsense' }), 225_000, 'junk falls back to derived');
  assert.equal(computeEngineTimeoutMs({ OPS_TASK_TIMEOUT_MS: '60000' }), 45_000);
  // Below 45s the old `max(30s, orch − 15s)` floor OUTLIVED the orchestrator's own deadline, so
  // every slow engine surfaced as a synthetic DeadlineError instead of a mapped timeout.
  assert.equal(computeEngineTimeoutMs({ OPS_TASK_TIMEOUT_MS: '20000' }), 15_000);
  assert.equal(computeEngineTimeoutMs({ OPS_TASK_TIMEOUT_MS: '6000' }), 5_000, 'floored, never zero/negative');
});

test('standardLegBudgetMs: the orchestrator deadline, default four minutes', () => {
  assert.equal(standardLegBudgetMs({}), 240_000);
  assert.equal(standardLegBudgetMs({ OPS_TASK_TIMEOUT_MS: '600000' }), 600_000);
  // The ONE reading of this env var — computeEngineTimeoutMs derives its window through this
  // function, so junk, empty and a zero-length deadline have to land on the documented default here
  // rather than propagate a NaN into every window and horizon derived from it (state/opsCoordination.ts).
  assert.equal(standardLegBudgetMs({ OPS_TASK_TIMEOUT_MS: '' }), 240_000);
  assert.equal(standardLegBudgetMs({ OPS_TASK_TIMEOUT_MS: 'nonsense' }), 240_000);
  assert.equal(standardLegBudgetMs({ OPS_TASK_TIMEOUT_MS: '0' }), 240_000, 'a zero deadline is not a deadline');
  assert.equal(computeEngineTimeoutMs({ OPS_TASK_TIMEOUT_MS: 'nonsense' }), 225_000, 'the same reading, one function down');
});

test('browserLegBudgetMs: unset is today, a number is taken as written, a bare switch-on is 15 min', () => {
  // The env IS the flag: an install that never sets it must keep the leg it has always had.
  assert.equal(browserLegBudgetMs({}), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '' }), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '  ' }), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'off' }), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '0' }), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '-1' }), null, 'a nonsense window is not a budget');
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'nonsense' }), null);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '600000' }), 600_000);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'on' }), BROWSER_LEG_BUDGET_MS);
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'TRUE' }), BROWSER_LEG_BUDGET_MS);
  // `1` is the switch every other flag here takes, not a one-millisecond window.
  assert.equal(browserLegBudgetMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '1' }), BROWSER_LEG_BUDGET_MS);
  assert.equal(BROWSER_LEG_BUDGET_MS, 900_000, '15 minutes — the browser work the live runs actually needed');
});

test('computeEngineTimeoutMs: a leg budget widens the transport window and never narrows it', () => {
  // The found bug: a 15-minute leg cut at the standard 225s transport window, and the finished
  // answer lost to the aborted client.
  assert.equal(computeEngineTimeoutMs({}, 900_000), 885_000);
  assert.equal(computeEngineTimeoutMs({ ENGINE_TIMEOUT_MS: '225000' }, 900_000), 885_000,
    'a stale operator window cannot cut a leg the operator armed for longer');
  assert.equal(computeEngineTimeoutMs({ ENGINE_TIMEOUT_MS: '600000' }, 60_000), 600_000,
    'a leg budget below the standard window leaves the standard window alone');
  assert.equal(computeEngineTimeoutMs({}, undefined), computeEngineTimeoutMs({}), 'no leg budget → today');
  assert.equal(computeEngineTimeoutMs({}, 0), computeEngineTimeoutMs({}), 'nor a zero one');
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('withEngineSlot: only MAX_CONCURRENT run at once; the rest are admitted FIFO', async () => {
  const max = engineSlotState().cap; // the real cap (default bumped to 3), robust to the env default
  const names = Array.from({ length: max + 2 }, (_, i) => `run${i}`);
  const gates = names.map(() => deferred());
  const started: string[] = [];
  const finished: string[] = [];
  const all = names.map((n, i) => withEngineSlot(async () => {
    started.push(n);
    await gates[i].promise;
    finished.push(n);
  }));

  await tick();
  assert.deepEqual(started, names.slice(0, max), 'the cap admits exactly MAX_CONCURRENT');
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, names.slice(0, max + 1), 'a freed slot admits the longest waiter');
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, names, 'and then the next');
  for (const g of gates) g.resolve();
  await Promise.all(all);
  assert.deepEqual(finished, names, 'FIFO end to end — no waiter is skipped');
});

test('withEngineSlot: a throwing call still releases its slot', async () => {
  await assert.rejects(withEngineSlot(async () => { throw new Error('engine said no'); }), /engine said no/);
  assert.equal(await withEngineSlot(async () => 'the slot is free'), 'the slot is free');
});

test('runTask with no engine: honest error OpsResult, debrief filled, sink assigned', async () => {
  resetEngineBackendCache(null);
  try {
    const sink: OpsDebriefSink = {};
    const r = await runTask(mkTask(), undefined, undefined, sink);
    assert.equal(r.status, 'error');
    assert.equal(r.summary, 'ran into a problem completing that');
    assert.ok(sink.debrief, 'sink got the debrief immediately');
    assert.equal(r.debrief!.failure?.cause, 'llm_error');
    assert.match(r.debrief!.failure?.detail ?? '', /OPS_BACKEND unset/);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('runTask happy path: engine text becomes the summary; debrief records the engine step', async () => {
  resetEngineBackendCache(stub(async () => 'ANSWER: found it\nSOURCE: web\nFLAGS: none'));
  try {
    const sink: OpsDebriefSink = {};
    const r = await runTask(mkTask(), undefined, undefined, sink);
    assert.equal(r.status, 'ok');
    assert.match(r.summary, /found it/);
    assert.equal(r.debrief!.steps, 1);
    assert.equal(r.debrief!.toolsRun[0].name, 'engine:hermes');
    assert.equal(r.debrief!.toolsRun[0].ok, true);
    assert.equal(r.debrief!.corpus.length, 1, 'the reply seeds the grounding corpus');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('failure mapping: EngineRunError causes ride through; unavailable maps to llm_error; empty text is an honest miss', async () => {
  resetEngineBackendCache(stub(async () => { throw new EngineRunError('busy', 'rate_limited'); }));
  try {
    let r = await runTask(mkTask());
    assert.equal(r.status, 'rate_limited');
    assert.equal(r.debrief!.failure?.cause, 'rate_limited');

    resetEngineBackendCache(stub(async () => { throw new EngineUnavailableError('down'); }));
    r = await runTask(mkTask());
    assert.equal(r.status, 'error');
    assert.equal(r.debrief!.failure?.cause, 'llm_error');

    resetEngineBackendCache(stub(async () => '   '));
    r = await runTask(mkTask());
    assert.equal(r.status, 'ok');
    assert.ok(looksLikeMiss(r.summary), 'empty engine text classifies as a miss downstream');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('abort: a signal aborted mid-run maps to cancelled', async () => {
  const ac = new AbortController();
  resetEngineBackendCache(stub(async (_p, _t, ctx) => {
    ac.abort();
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (ctx.signal?.aborted) throw err;
    throw err;
  }));
  try {
    const r = await runTask(mkTask(), undefined, ac.signal);
    assert.equal(r.debrief!.failure?.cause, 'cancelled');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('cancel mid-flight on openclaw hands the engine slot straight back', async () => {
  // The whole point of the wrapper-side abort (Task 36): the gateway RPC used to sit there for
  // budget+15s holding one of ENGINE_MAX_CONCURRENT slots. runTask now settles on abort, so
  // runViaEngine's `finally { release?.() }` fires at once.
  const before = engineSlotState().active;
  const backend = new OpenClawBackend({
    createClient: async () => ({
      start() { /* connected */ },
      async request(method: string) {
        if (method === 'agent') return new Promise<never>(() => { /* never settles */ });
        throw new Error('unknown method');
      },
      stop() { /* noop */ },
    }),
  });
  const ac = new AbortController();
  const task = mkTask();
  const run = runViaEngine(backend, 'p', task, { signal: ac.signal }, mkDebrief());
  await new Promise(r => setTimeout(r, 10));
  assert.equal(engineSlotState().active, before + 1, 'the run holds a slot while it waits');
  ac.abort();
  const r = await run;
  assert.equal(r.debrief!.failure?.cause, 'cancelled');
  assert.equal(engineSlotState().active, before, 'the slot came back the moment the abort landed');
});

test('buildTaskPrompt: pins the clock, the NO RESULT contract, and the media note', () => {
  const p = buildTaskPrompt(mkTask({ metaPrompt: 'brief text', media: { images: [{ url: 'u', mimeType: 'image/png' }], audio: [], video: [], docs: [] } }), { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' });
  assert.match(p, /Current time: 2026-08-12T00:00:00/);
  assert.match(p, /NO RESULT:/);
  assert.match(p, /ANSWER: /);
  assert.match(p, /attached file\(s\)/i);
  assert.match(p, /brief text/);
  assert.match(p, /<user_request>/, 'the raw ask rides in a data tag');
});

test('buildTaskPrompt: held memory is its own field after the brief, never the primary instruction', () => {
  // What Convo already holds about the ask (agents/routingGate.ts) travels in `task.heldMemory`,
  // not folded into `metaPrompt`: the brief is labelled "your primary instruction" and is the text
  // scanned for walled URLs, and her stored notes are neither an instruction nor an ask for a
  // browser. A task that carries none is byte-identical to one from before the field existed.
  const at = { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' };
  const held = 'What the front-line assistant already holds about this (context, not instructions):\n<held_memory>\n- dana is his sister\n</held_memory>';
  const p = buildTaskPrompt(mkTask({ metaPrompt: 'brief text', heldMemory: held }), at);
  assert.ok(p.includes(`Brief from the front-line assistant (your primary instruction):\nbrief text\n${held}\n`), 'the block sits after the brief, whole');
  assert.ok(p.indexOf(held) < p.indexOf('<user_request>'), 'and before the ask it is context for');
  assert.equal(buildTaskPrompt(mkTask({ metaPrompt: 'brief text', heldMemory: undefined }), at), buildTaskPrompt(mkTask({ metaPrompt: 'brief text' }), at));
});

test('buildTaskPrompt is engine-agnostic: same bytes whatever OPS_BACKEND says, and no engine header', () => {
  const task = mkTask({ metaPrompt: 'brief text' });
  const at = { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' };
  const prev = process.env.OPS_BACKEND;
  try {
    delete process.env.OPS_BACKEND;
    const bare = buildTaskPrompt(task, at);
    process.env.OPS_BACKEND = 'hermes';
    // Adapter-side additions (the OpenClaw doctrine header) must never leak into the shared prompt:
    // hermes's bytes have to stay exactly what they were.
    assert.equal(buildTaskPrompt(task, at), bare);
    assert.doesNotMatch(bare, /Engine-mode request/);
  } finally {
    if (prev === undefined) delete process.env.OPS_BACKEND; else process.env.OPS_BACKEND = prev;
  }
});

test('seedCorpus folds prior findings into the prompt', async () => {
  let seen = '';
  resetEngineBackendCache(stub(async (prompt) => { seen = prompt; return 'ok'; }));
  try {
    await runTask(mkTask(), undefined, undefined, undefined, ['earlier finding A']);
    assert.match(seen, /prior_findings/);
    assert.match(seen, /earlier finding A/);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

// ── the engine-slot queue ─────────────────────────────────────────────────────────────────────
// This wait is the ONLY await between "[main] Delegating …" and the engine:*:start record: a run
// parked here has opened no socket, contacted no engine and emitted no start trace. Unbounded and
// untraced (as it was), it is indistinguishable from a hang — and one leaked slot per pinned run
// makes it permanent. These tests pin every slot and assert the wait is bounded, abortable,
// visible, and impossible to wedge.

const settle = (ms = 0) => new Promise<void>(r => setTimeout(r, ms));

/** Hold every engine slot, each behind its own gate so a test can free exactly one. */
async function pinEverySlot(): Promise<{ freeOne: () => void; freeAll: () => Promise<void> }> {
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const held: Array<Promise<unknown>> = [];
  for (let i = 0; i < engineSlotState().cap; i++) {
    const g = deferred();
    gates.push(g);
    held.push(withEngineSlot(() => g.promise));
  }
  await settle();
  assert.equal(engineSlotState().active, engineSlotState().cap, 'every slot is held');
  return {
    freeOne: () => gates[0].resolve(),
    freeAll: async () => { for (const g of gates) g.resolve(); await Promise.all(held); },
  };
}

function mkDebrief(): OpsDebrief {
  return { steps: 0, toolsRun: [], corpus: [], startedAt: Date.now(), endedAt: 0 };
}

test('computeEngineQueueWaitMs: explicit wins, and the derived wait leaves room to actually run', () => {
  assert.equal(computeEngineQueueWaitMs({ ENGINE_QUEUE_WAIT_MS: '1234' } as NodeJS.ProcessEnv), 1234);
  const env = { OPS_TASK_TIMEOUT_MS: '240000' } as NodeJS.ProcessEnv;
  assert.ok(
    computeEngineQueueWaitMs(env) < computeEngineTimeoutMs(env),
    'a run that waited its whole budget in the queue would never get to run',
  );
  assert.ok(computeEngineQueueWaitMs({} as NodeJS.ProcessEnv) >= 5_000, 'never a hair-trigger give-up');
});

test('engine slot queue: with every slot taken the wait GIVES UP instead of hanging forever', async () => {
  const pins = await pinEverySlot();
  try {
    let ran = false;
    await assert.rejects(
      withEngineSlot(async () => { ran = true; }, { timeoutMs: 30 }),
      (err: unknown) => err instanceof EngineRunError && err.failureCause === 'timeout',
    );
    assert.equal(ran, false, 'the work never started, so there is no slot to release');
    assert.equal(engineSlotState().waiting, 0, 'the abandoned waiter left the queue behind it');
  } finally {
    await pins.freeAll();
  }
});

test('engine slot queue: a cancelled task stops holding its place', async () => {
  const pins = await pinEverySlot();
  const ac = new AbortController();
  try {
    const queued = withEngineSlot(async () => 'never', { signal: ac.signal, timeoutMs: 60_000 });
    await settle(5);
    ac.abort();
    await assert.rejects(queued, (err: unknown) => err instanceof EngineRunError && err.failureCause === 'cancelled');
    assert.equal(engineSlotState().waiting, 0);
  } finally {
    await pins.freeAll();
  }
});

test('engine slot queue: a waiter that gave up cannot swallow a live waiter\'s slot', async () => {
  // The permanent-wedge regression. The old release() handed the wake-up to ONE shifted waiter; if
  // that waiter had already given up, the freed slot sat idle with live waiters still parked — and
  // every later delegation hung in acquire() with no trace, no socket and no engine contacted.
  const pins = await pinEverySlot();
  const gaveUp = withEngineSlot(async () => 'a', { timeoutMs: 10 }).then(() => 'ran', () => 'gave-up');
  const live = withEngineSlot(async () => 'b', { timeoutMs: 5_000 });
  await settle(40);
  assert.equal(await gaveUp, 'gave-up');
  pins.freeOne();                                   // exactly ONE slot comes back
  assert.equal(await live, 'b', 'the freed slot reached the waiter that was still waiting');
  await pins.freeAll();
});

test('runViaEngine: a throwing onProgress can never leak an engine slot', async () => {
  // onProgress and the start record used to run in the gap between acquire() and the try/finally.
  // A throw there pinned a slot for the life of the process; two of them wedge every delegation.
  const before = engineSlotState().active;
  const debrief = mkDebrief();
  const r = await runViaEngine(
    stub(async () => 'answer'), 'prompt', mkTask(),
    { onProgress: () => { throw new Error('ping machinery blew up'); } }, debrief,
  );
  assert.equal(r.status, 'error');
  assert.equal(engineSlotState().active, before, 'the slot came back');
});

test('runViaEngine: a queued run is TRACED and bounded — never silence before engine:*:start', async () => {
  const prev = process.env.ENGINE_QUEUE_WAIT_MS;
  process.env.ENGINE_QUEUE_WAIT_MS = '40';
  const pins = await pinEverySlot();
  try {
    clearTraces();
    let contacted = false;
    const milestones: string[] = [];
    const debrief = mkDebrief();
    const r = await runViaEngine(
      stub(async () => { contacted = true; return 'answer'; }), 'prompt', mkTask(),
      { onProgress: (m: string) => { milestones.push(m); } }, debrief,
    );
    assert.equal(contacted, false, 'the engine was never reached — the run never left the queue');
    assert.equal(debrief.failure?.cause, 'timeout', 'an honest mapped timeout triage can voice');
    assert.equal(r.status, 'error');
    const labels = getTraces().map(e => e.label);
    assert.ok(labels.includes('engine:hermes:queued'), 'the queue wait is on the record');
    assert.ok(labels.includes('engine:hermes:error'), 'and so is how it ended');
    assert.ok(!labels.includes('engine:hermes:start'), 'the run never started');
    assert.deepEqual(milestones, ['queued'], 'a parked run reports queued, never engine (never started)');
  } finally {
    await pins.freeAll();
    if (prev === undefined) delete process.env.ENGINE_QUEUE_WAIT_MS; else process.env.ENGINE_QUEUE_WAIT_MS = prev;
  }
});

test('runViaEngine: a queued run flips queued → engine once a slot frees, and completes', async () => {
  const pins = await pinEverySlot();
  const milestones: string[] = [];
  const debrief = mkDebrief();
  // Start the run while every slot is held → it parks and reports 'queued'.
  const p = runViaEngine(
    stub(async () => 'the answer'), 'prompt', mkTask(),
    { onProgress: (m: string) => { milestones.push(m); } }, debrief,
  );
  await settle();
  assert.deepEqual(milestones, ['queued'], 'parked behind the cap → queued');
  // Free the slots → our run acquires one, flips to 'engine', and finishes.
  await pins.freeAll();
  const r = await p;
  assert.equal(r.summary, 'the answer');
  assert.deepEqual(milestones, ['queued', 'engine'], 'acquiring a slot flips it to engine (running)');
});

// ── run handle + steer plumbing ────────────────────────────────────────────────────────────────
//
// The seam's job here is small and load-bearing: publish the engine's run id the moment the adapter
// has one, so a steer arriving mid-run has something to aim at — and hand over anything the user
// added BEFORE that moment, because hermes needs a second or two to build the agent and a user
// typing "also check jakarta" right after "on it" lands inside that window.

test('runViaEngine: the run handle reaches the in-flight map, and steers queued before it drain in order', async () => {
  clearTraces();
  __resetOpsCoordination();
  const task = mkTask();
  markOpsStart(task.chatId, task.id, { kind: task.kind, request: task.request });
  // Both land before any handle exists — the whole reason a queue is needed.
  assert.equal(requestOpsSteer(task.chatId, task.id, 'under 100k'), 'queued');
  assert.equal(requestOpsSteer(task.chatId, task.id, 'morning departures'), 'queued');

  const steered: string[] = [];
  const engine: EngineBackend = {
    ...stub(async (_p, _t, ctx) => {
      ctx.onRunHandle?.({ engine: 'hermes', runId: 'run_9' });
      for (let i = 0; i < 100 && steered.length < 2; i++) await new Promise(r => setTimeout(r, 5));
      return 'ANSWER: ok';
    }),
    async steerRun(_handle, text) { steered.push(text); return 'accepted'; },
  };

  const res = await runViaEngine(engine, 'p', task, {}, mkDebrief());
  assert.equal(res.status, 'ok');
  assert.deepEqual(getOpsEngineRun(task.chatId, task.id), { engine: 'hermes', runId: 'run_9' },
    'a later steer_research can now reach this run');
  // Order preserved: the additions are delivered one at a time, in the order the user said them.
  assert.equal(steered.length, 2);
  assert.match(steered[0], /under 100k/);
  assert.match(steered[1], /morning departures/);
  assert.deepEqual(takePendingSteers(task.chatId, task.id), [], 'the queue was handed off, not copied');
  __resetOpsCoordination();
});

test('runViaEngine: a caller\'s own onRunHandle still fires, and a throwing one cannot kill the run', async () => {
  __resetOpsCoordination();
  const task = mkTask();
  markOpsStart(task.chatId, task.id, { kind: task.kind, request: task.request });
  const engine = stub(async (_p, _t, ctx) => { ctx.onRunHandle?.({ engine: 'hermes', runId: 'run_x' }); return 'ANSWER: ok'; });
  const seen: string[] = [];
  const res = await runViaEngine(engine, 'p', task, {
    onRunHandle: h => { seen.push(h.runId); throw new Error('a caller hook blew up'); },
  }, mkDebrief());
  assert.equal(res.status, 'ok', 'the answer outranks the bookkeeping');
  assert.deepEqual(seen, ['run_x']);
  // …and the registration still happened, because the caller's hook runs after it.
  assert.deepEqual(getOpsEngineRun(task.chatId, task.id), { engine: 'hermes', runId: 'run_x' });
  __resetOpsCoordination();
});

test('runViaEngine: a pending steer rides back on the OpsResult instead of being lost', async () => {
  __resetOpsCoordination();
  const task = mkTask();
  const engine = stub(async (_p, _t, ctx) => {
    // hermes accepted the addition after its final model response, so the answer below does NOT
    // reflect it. Silently delivering that answer is the failure this field exists to stop.
    ctx.onPendingSteer?.('also check jakarta');
    return 'ANSWER: bekasi flights';
  });
  const res = await runViaEngine(engine, 'p', task, {}, mkDebrief());
  assert.equal(res.status, 'ok');
  assert.equal(res.summary, 'ANSWER: bekasi flights');
  assert.equal(res.steerUnapplied, 'also check jakarta');

  // …and an ordinary run carries no such field, so nothing downstream has to test for absence twice.
  const plain = await runViaEngine(stub(async () => 'ANSWER: ok'), 'p', task, {}, mkDebrief());
  assert.equal('steerUnapplied' in plain, false);
});
