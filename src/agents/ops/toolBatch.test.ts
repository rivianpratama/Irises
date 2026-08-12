// Run with: $env:TZ='UTC'; npx tsx --test src/agents/ops/toolBatch.test.ts
// runToolBatch is the concurrency layer under a step's tool calls. The invariants that matter:
//  - results ALWAYS come back in original call order (grounding corpus + debrief depend on it),
//  - all-read-only batches actually run concurrently; any mutating tool forces sequential,
//  - budget-skip / needs_auth / launch bookkeeping match the old strictly-sequential loop.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolBatch, budgetSkipNote, type ToolBatchDeps, type ToolCallLike } from './client.js';

const WRITE = new Set(['schedule_followup']);   // the one Ops tool with a side effect

// A `run` that tracks max concurrency: live count peaks at the batch size iff calls truly overlap.
function tracker() {
  let live = 0, maxLive = 0;
  const launched: string[] = [];
  const run: ToolBatchDeps['run'] = async (name) => {
    live++; maxLive = Math.max(maxLive, live);
    await Promise.resolve();   // yield: in a parallel batch every call increments before any resolves
    live--;
    return { result: `RESULT:${name}` };
  };
  return { run, maxLive: () => maxLive, launched };
}

function baseDeps(over: Partial<ToolBatchDeps> = {}): ToolBatchDeps {
  return {
    run: async (name) => ({ result: `RESULT:${name}` }),
    budgetExceeded: () => false,
    isMutating: (name) => WRITE.has(name),
    parallel: true,
    ...over,
  };
}
const calls = (...names: string[]): ToolCallLike[] => names.map(n => ({ name: n, input: {} }));

test('all read-only → runs concurrently, results in ORIGINAL order', async () => {
  const t = tracker();
  const results = await runToolBatch(calls('search_email', 'read_email', 'read_url'), baseDeps({ run: t.run }));
  assert.deepEqual(results.map(r => r.call.name), ['search_email', 'read_email', 'read_url']);
  assert.deepEqual(results.map(r => r.result), ['RESULT:search_email', 'RESULT:read_email', 'RESULT:read_url']);
  assert.equal(t.maxLive(), 3, 'read-only batch did not overlap — parallelism is not happening');
});

test('a mutating tool in the batch forces the WHOLE batch sequential (order preserved)', async () => {
  const t = tracker();
  const results = await runToolBatch(calls('search_email', 'schedule_followup', 'read_email'), baseDeps({ run: t.run }));
  assert.deepEqual(results.map(r => r.call.name), ['search_email', 'schedule_followup', 'read_email']);
  assert.equal(t.maxLive(), 1, 'a batch with a mutating tool must not overlap');
});

test('parallel disabled → sequential even for all-read-only', async () => {
  const t = tracker();
  const results = await runToolBatch(calls('search_email', 'read_email'), baseDeps({ run: t.run, parallel: false }));
  assert.equal(t.maxLive(), 1);
  assert.deepEqual(results.map(r => r.call.name), ['search_email', 'read_email']);
});

test('a single call never fans out (length>1 guard) but still returns correctly', async () => {
  const t = tracker();
  const results = await runToolBatch(calls('search_email'), baseDeps({ run: t.run }));
  assert.equal(t.maxLive(), 1);
  assert.equal(results[0].result, 'RESULT:search_email');
  assert.equal(results[0].skipped, false);
});

test('onLaunch fires in ORIGINAL order, non-skipped only', async () => {
  const launched: string[] = [];
  const results = await runToolBatch(
    calls('search_email', 'read_email', 'read_url'),
    baseDeps({ onLaunch: (c) => launched.push(c.name) }),
  );
  assert.deepEqual(launched, ['search_email', 'read_email', 'read_url']);
  assert.equal(results.length, 3);
});

test('budget exhausted up front → every call skipped with the note, none launched, no onLaunch', async () => {
  const launched: string[] = [];
  let ran = 0;
  const results = await runToolBatch(
    calls('search_email', 'read_email'),
    baseDeps({
      budgetExceeded: () => true,
      run: async (n) => { ran++; return { result: `RESULT:${n}` }; },
      onLaunch: (c) => launched.push(c.name),
    }),
  );
  assert.equal(ran, 0, 'a skipped call must not run');
  assert.deepEqual(launched, [], 'a skipped call must not fire launch bookkeeping');
  assert.ok(results.every(r => r.skipped));
  assert.equal(results[0].result, budgetSkipNote('search_email'));
});

test('sequential budget trip mid-batch: earlier calls run, later ones skip (order kept)', async () => {
  let ran = 0;
  const results = await runToolBatch(
    calls('search_email', 'read_email', 'read_url'),
    baseDeps({
      parallel: false,
      budgetExceeded: () => ran >= 1,     // trips after the first call has run
      run: async (n) => { ran++; return { result: `RESULT:${n}` }; },
    }),
  );
  assert.deepEqual(results.map(r => r.skipped), [false, true, true]);
  assert.equal(results[0].result, 'RESULT:search_email');
  assert.equal(results[1].result, budgetSkipNote('read_email'));
});

test('sequential path STOPS at the first needs_auth (matches the old return-on-needsAuth)', async () => {
  let ran = 0;
  const results = await runToolBatch(
    calls('read_email', 'schedule_followup', 'read_url'),   // has a mutating tool → sequential
    baseDeps({
      run: async (n) => { ran++; return { result: `RESULT:${n}`, needsAuth: n === 'read_email' }; },
    }),
  );
  assert.equal(ran, 1, 'later tools must not run after a needs_auth');
  assert.equal(results.length, 1);
  assert.equal(results[0].needsAuth, true);
});

test('parallel read-only path: all reads ran, results preserve order + flag needs_auth', async () => {
  const results = await runToolBatch(
    calls('search_email', 'read_email', 'read_url'),
    baseDeps({ run: async (n) => ({ result: `RESULT:${n}`, needsAuth: n === 'read_email' }) }),
  );
  assert.deepEqual(results.map(r => r.call.name), ['search_email', 'read_email', 'read_url']);
  assert.equal(results[1].needsAuth, true);
  assert.equal(results[0].needsAuth, false);
});

test('durationMs is measured from the injected clock', async () => {
  const times = [100, 137];   // start, end
  let i = 0;
  const results = await runToolBatch(
    calls('search_email'),
    baseDeps({ now: () => times[i++], run: async (n) => ({ result: `RESULT:${n}` }) }),
  );
  assert.equal(results[0].durationMs, 37);
});
