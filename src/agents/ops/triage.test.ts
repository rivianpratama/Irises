process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCause, decide, splitMiss } from './triage.js';
import type { OpsResult, OpsTask, OpsDebrief } from '../types.js';
import type { LlmResult } from '../../llm/types.js';

// NOTE: OPS_RETRY_ENABLED defaults to true when the env var is unset (the test env). The engine IS
// the strong model, so researchable failures resolve to 'none' (today's transient/miss beat) — the
// single cheap retry is the whole ladder.

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'c1', agentHandle: 'h1', kind: 'general', request: 'find the date on that invoice',
    createdAt: 0, ...over,
  };
}

function mkDebrief(over: Partial<OpsDebrief> = {}): OpsDebrief {
  return { steps: 1, toolsRun: [], corpus: [], startedAt: 0, endedAt: 1, ...over };
}

function mkResult(over: Partial<OpsResult> = {}): OpsResult {
  return { taskId: 't1', kind: 'general', status: 'ok', summary: 'no result', ...over };
}

function fakeLlm(text: string | null): (req: unknown) => Promise<LlmResult> {
  return async () => ({ text, toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' });
}

// ── detectCause ──────────────────────────────────────────────────────────────

test('detectCause: timeout flag wins over everything', () => {
  assert.equal(detectCause(mkResult({ status: 'ok', summary: 'a real answer' }), true), 'timeout');
});

test('detectCause: needs_auth from the debrief (engine rejected the API key)', () => {
  assert.equal(detectCause(mkResult({ status: 'error', summary: 'ran into a problem completing that', debrief: mkDebrief({ failure: { cause: 'needs_auth' } }) }), false), 'needs_auth');
});

test('detectCause: cancelled sentinel from summary', () => {
  assert.equal(detectCause(mkResult({ status: 'error', summary: 'cancelled' }), false), 'cancelled');
});

test('detectCause: fidelity + tool_errors from the debrief', () => {
  assert.equal(detectCause(mkResult({ summary: 'NO RESULT: ...', debrief: mkDebrief({ failure: { cause: 'fidelity_suppressed', ungrounded: ['currency: $5,000'] } }) }), false), 'fidelity_suppressed');
  assert.equal(detectCause(mkResult({ summary: 'no result', debrief: mkDebrief({ failure: { cause: 'tool_errors' } }) }), false), 'tool_errors');
});

test('detectCause: llm_error from error status; empty_miss from clean-but-empty; rate_limited', () => {
  assert.equal(detectCause(mkResult({ status: 'error', summary: 'ran into a problem completing that', debrief: mkDebrief({ failure: { cause: 'llm_error' } }) }), false), 'llm_error');
  assert.equal(detectCause(mkResult({ status: 'ok', summary: 'no result' }), false), 'empty_miss');
  assert.equal(detectCause(mkResult({ status: 'rate_limited', summary: 'x' }), false), 'rate_limited');
});

// ── decide (deterministic matrix) ─────────────────────────────────────────────

test('decide: researchable causes resolve to none (no deeper leg exists)', () => {
  for (const cause of ['timeout', 'tool_errors', 'fidelity_suppressed'] as const) {
    assert.equal(decide(cause, mkTask()).action, 'none', `${cause} should resolve to none`);
  }
});

test('decide: transient lane causes take the cheap retry', () => {
  // OPS_RETRY_ENABLED defaults true in the test env, so llm_error/rate_limited take one cheap
  // same-role retry (a fresh attempt often clears an infrastructure blip).
  for (const cause of ['llm_error', 'rate_limited'] as const) {
    assert.equal(decide(cause, mkTask()).action, 'retry', `${cause} should retry`);
  }
});

test('decide: a retry leg (retryOf set) is terminal — nothing ladders further', () => {
  // Slim: the single cheap retry is the whole ladder; every cause on a retry leg resolves to none.
  for (const cause of ['timeout', 'tool_errors', 'fidelity_suppressed', 'llm_error', 'rate_limited'] as const) {
    assert.equal(decide(cause, mkTask({ retryOf: 't1' })).action, 'none', `${cause} on a retry leg should resolve to none`);
  }
});

test('decide: needs_auth and cancelled do nothing; a tripped budget gives up (never a bigger fire)', () => {
  assert.equal(decide('needs_auth', mkTask()).action, 'none');
  assert.equal(decide('cancelled', mkTask()).action, 'none');
  assert.equal(decide('budget', mkTask()).action, 'give_up');
});

// ── splitMiss (the one LLM call, injected) ────────────────────────────────────

test('splitMiss: INFO_HOLE → ask_user with the missing fields', async () => {
  const d = await splitMiss(mkResult(), mkTask(), fakeLlm('{"verdict":"INFO_HOLE","missing":["which invoice (there are two)"],"directive":""}') as never);
  assert.equal(d.action, 'ask_user');
  assert.deepEqual(d.missingFields, ['which invoice (there are two)']);
  assert.equal(d.deterministic, false);
});

test('splitMiss: INFO_HOLE on attempt 2 gives up (never re-interrogate)', async () => {
  const d = await splitMiss(mkResult(), mkTask({ attempt: 2 }), fakeLlm('{"verdict":"INFO_HOLE","missing":["which one"],"directive":""}') as never);
  assert.equal(d.action, 'give_up');
});

test('splitMiss: INFO_HOLE with no concrete field falls back to none (generic steering)', async () => {
  const d = await splitMiss(mkResult(), mkTask(), fakeLlm('{"verdict":"INFO_HOLE","missing":[],"directive":""}') as never);
  assert.equal(d.action, 'none');
});

test('splitMiss: RESEARCH_GAP resolves to none (the engine IS the strong model — no deeper leg)', async () => {
  const ok = await splitMiss(mkResult(), mkTask(), fakeLlm('{"verdict":"RESEARCH_GAP","missing":[],"directive":"check the attachments, not just the email bodies"}') as never);
  assert.equal(ok.action, 'none');
  const onRetryLeg = await splitMiss(mkResult(), mkTask({ retryOf: 't1' }), fakeLlm('{"verdict":"RESEARCH_GAP","missing":[],"directive":"go deeper"}') as never);
  assert.equal(onRetryLeg.action, 'none');
});

test('splitMiss: UNANSWERABLE → give_up', async () => {
  const d = await splitMiss(mkResult(), mkTask(), fakeLlm('{"verdict":"UNANSWERABLE","missing":[],"directive":""}') as never);
  assert.equal(d.action, 'give_up');
});

test('splitMiss: garbage / null / throw all degrade to none', async () => {
  assert.equal((await splitMiss(mkResult(), mkTask(), fakeLlm('not json at all') as never)).action, 'none');
  assert.equal((await splitMiss(mkResult(), mkTask(), fakeLlm(null) as never)).action, 'none');
  const thrower = (async () => { throw new Error('boom'); }) as never;
  assert.equal((await splitMiss(mkResult(), mkTask(), thrower)).action, 'none');
});

test('splitMiss: missing fields are capped at 3 items and 120 chars each', async () => {
  const long = 'x'.repeat(200);
  const d = await splitMiss(mkResult(), mkTask(), fakeLlm(`{"verdict":"INFO_HOLE","missing":["${long}","b","c","d","e"],"directive":""}`) as never);
  assert.equal(d.action, 'ask_user');
  assert.equal(d.missingFields!.length, 3);
  assert.equal(d.missingFields![0].length, 120);
});
