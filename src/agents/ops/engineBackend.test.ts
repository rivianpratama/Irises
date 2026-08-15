// Seam tests: dispatch resolution, the runTask contract (debrief/sink/fallback shapes), and
// failure→OpsFailureCause mapping — all with stubbed backends via resetEngineBackendCache (DI).

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetEngineBackendCache, getEngineBackend, withEngineSlot, computeEngineTimeoutMs, EngineRunError, EngineUnavailableError, type EngineBackend } from './engineBackend.js';
import { runTask, buildTaskPrompt, looksLikeMiss } from './client.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask, OpsDebriefSink } from '../types.js';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('withEngineSlot: only MAX_CONCURRENT run at once; the rest are admitted FIFO', async () => {
  const max = Number(process.env.ENGINE_MAX_CONCURRENT) || 2;
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

test('buildTaskPrompt: pins the clock, the NO RESULT contract, and the media note', () => {
  const p = buildTaskPrompt(mkTask({ metaPrompt: 'brief text', media: { images: [{ url: 'u', mimeType: 'image/png' }], audio: [], video: [], docs: [] } }), { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' });
  assert.match(p, /Current time: 2026-08-12T00:00:00/);
  assert.match(p, /NO RESULT:/);
  assert.match(p, /ANSWER: /);
  assert.match(p, /attached file\(s\)/i);
  assert.match(p, /brief text/);
  assert.match(p, /<user_request>/, 'the raw ask rides in a data tag');
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
