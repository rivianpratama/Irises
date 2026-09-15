process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCause, decide, splitMiss, retryTaskFor, steerReplayTaskFor, canRetry, type TriageDecision } from './triage.js';
import { browserRetryDirective } from './walledUrls.js';
import { buildTaskPrompt } from './client.js';
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

// ── the walled-URL escalation: deterministic, decided BEFORE the LLM verdict ──
//
// The live failure this is for (VPS, 2026-09-02): an instagram reel ask came back empty because the
// engine curled a login shell instead of opening the page, and the splitter — reading an empty tool
// ledger — called it UNANSWERABLE and gave up on the FIRST attempt.

const REEL = 'https://www.instagram.com/reel/DcJg4VkgMT0/';
const REEL_ASK = `who is the girl in ${REEL}`;
const UNANSWERABLE = '{"verdict":"UNANSWERABLE","missing":[],"directive":""}';

function countingLlm(text: string): { llm: never; calls: () => number } {
  let calls = 0;
  const llm = (async () => { calls++; return { text, toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' }; }) as never;
  return { llm, calls: () => calls };
}

function withHintFlag(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.OPS_WALLED_URL_HINT;
  if (value === undefined) delete process.env.OPS_WALLED_URL_HINT;
  else process.env.OPS_WALLED_URL_HINT = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.OPS_WALLED_URL_HINT; else process.env.OPS_WALLED_URL_HINT = prev;
  });
}

test('splitMiss: a walled URL the engine could have browsed retries deterministically, no LLM call', async () => {
  const { llm, calls } = countingLlm(UNANSWERABLE);
  const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK }), llm, true);
  assert.equal(d.cause, 'empty_miss');
  assert.equal(d.action, 'retry');
  assert.equal(d.deterministic, true);
  assert.equal(d.directive, `The first pass never opened the page in a browser. browser_navigate to ${REEL}, read the caption/tags/comments from the rendered page, then answer.`);
  assert.equal(calls(), 0, 'the branch sits BEFORE the one LLM call — no tokens spent to learn what the URL already says');
});

test('splitMiss: the walled URL can ride in the brief instead of the ask', async () => {
  const d = await splitMiss(mkResult(), mkTask({ request: 'who is the girl', metaPrompt: `akses ${REEL} itu, cepet` }), fakeLlm(UNANSWERABLE) as never, true);
  assert.equal(d.action, 'retry');
  assert.match(d.directive!, /browser_navigate to https:/);
});

test('splitMiss: attempt 2 falls through to today’s verdict (the escalation is a first-look move)', async () => {
  const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK, attempt: 2 }), fakeLlm(UNANSWERABLE) as never, true);
  assert.equal(d.action, 'give_up');
  assert.equal(d.deterministic, false);
  assert.equal(d.directive, undefined);
});

test('splitMiss: no browser to escalate TO → today’s verdict stands', async () => {
  // false = the engine reported its toolsets and has no browser; undefined = nobody could say yet
  // (a cold capability cache). Neither is a promise, so neither buys a leg.
  for (const browser of [false, undefined] as const) {
    const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK }), fakeLlm(UNANSWERABLE) as never, browser);
    assert.equal(d.action, 'give_up', `browser=${browser} should not escalate`);
    assert.equal(d.deterministic, false);
  }
});

test('splitMiss: a retry leg never escalates again — one browser leg per attempt', async () => {
  const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK, retryOf: 't1' }), fakeLlm(UNANSWERABLE) as never, true);
  assert.equal(d.action, 'give_up');
});

test('splitMiss: an ask with no walled URL is untouched by the escalation', async () => {
  const d = await splitMiss(mkResult(), mkTask({ request: 'who is the girl in https://example.com/gallery/7' }), fakeLlm(UNANSWERABLE) as never, true);
  assert.equal(d.action, 'give_up');
});

test('splitMiss: OPS_WALLED_URL_HINT off → the escalation never arms', async () => {
  await withHintFlag('false', async () => {
    const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK }), fakeLlm(UNANSWERABLE) as never, true);
    assert.equal(d.action, 'give_up');
    assert.equal(d.deterministic, false);
  });
  await withHintFlag('true', async () => {
    const d = await splitMiss(mkResult(), mkTask({ request: REEL_ASK }), fakeLlm(UNANSWERABLE) as never, true);
    assert.equal(d.action, 'retry');
  });
});

// ── retryTaskFor: the escalated leg has to be told something the first one wasn't ──
//
// Review r1 / Important #1. The escalation's `directive` had NO consumer: the orchestrator built
// `{...task, retryOf}` and buildTaskPrompt derives every field from kind/hints/media/metaPrompt/
// request — none of which that spread changes — so the second leg re-sent a byte-identical prompt
// (same `tooling:` line included, since the escalation arms on exactly the condition that inserted
// it) and burned up to OPS_TASK_TIMEOUT_MS to re-roll the same dice. The retry task is built here,
// pure, so both the folding and the untouched transient path are pinnable.

const AT = { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' };

test('retryTaskFor: the browser directive rides into the retry brief — and changes the prompt', () => {
  const task = mkTask({ request: REEL_ASK, metaPrompt: 'sources: web research — akses URL IG reel itu / depth: cepet' });
  const decision: TriageDecision = {
    cause: 'empty_miss', action: 'retry', deterministic: true, directive: browserRetryDirective(REEL),
  };
  const retry = retryTaskFor(task, decision);
  assert.equal(retry.id, task.id, 'same task id — cancel / dedupe / trace continuity');
  assert.equal(retry.retryOf, task.id, 'still the retry leg the orchestrator’s bookkeeping expects');
  assert.ok(retry.metaPrompt!.startsWith(task.metaPrompt!), 'the front-line brief still leads');
  assert.ok(retry.metaPrompt!.includes(`browser_navigate to ${REEL}`), 'and the directive is appended to it');
  // The point of the whole fix: the second pass is NOT the first prompt again.
  assert.notEqual(
    buildTaskPrompt(retry, { ...AT, browser: true }),
    buildTaskPrompt(task, { ...AT, browser: true }),
    'the escalated leg must not re-send byte-identical bytes',
  );
});

test('retryTaskFor: no directive → exactly today’s retry task (the transient path is untouched)', () => {
  const task = mkTask({ metaPrompt: 'the original brief' });
  const decisions: TriageDecision[] = [
    { cause: 'llm_error', action: 'retry', deterministic: true },              // the cheap transient retry
    { cause: 'empty_miss', action: 'retry', deterministic: true, directive: '' }, // an empty directive is no directive
  ];
  for (const decision of decisions) {
    assert.deepEqual(retryTaskFor(task, decision), { ...task, retryOf: task.id },
      `${decision.cause} must build the pre-fix retry task byte for byte`);
  }
});

test('retryTaskFor: a brief-less task gets the directive as its whole brief', () => {
  const retry = retryTaskFor(mkTask({ request: REEL_ASK }), {
    cause: 'empty_miss', action: 'retry', deterministic: true, directive: 'open it in a browser',
  });
  assert.equal(retry.metaPrompt, 'open it in a browser', 'never "undefined\\n\\n…"');
});

// ── steerReplayTaskFor: an addition the engine took but never applied ──────────────────────────

test('steerReplayTaskFor: the addition rides into the brief, and the replay is the last leg', () => {
  const task = mkTask({ request: 'flights to bekasi next week' });
  const replay = steerReplayTaskFor(task, '  also check jakarta  ');

  assert.equal(replay.request, 'flights to bekasi next week\nThe user added mid-run: also check jakarta');
  assert.equal(replay.id, task.id, 'same id — cancel, dedupe, trace continuity and markOpsDone all key on it');
  assert.equal(replay.retryOf, task.id);
  // The bound that matters: this leg follows one that already ANSWERED, so there is no third leg.
  assert.equal(canRetry(replay), false);
  // And it really is a different prompt — a byte-identical re-send would just spend an engine run.
  assert.notEqual(buildTaskPrompt(replay, {}), buildTaskPrompt(task, {}));
  assert.match(buildTaskPrompt(replay, {}), /The user added mid-run: also check jakarta/);
});
