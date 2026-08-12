process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCause, decide, splitMiss, buildEscalationMetaPrompt } from './triage.js';
import { looksLikeToolError } from './client.js';
import type { OpsResult, OpsTask, OpsDebrief, TaskKind } from '../types.js';
import type { LlmResult } from '../../llm/types.js';

// NOTE: OPS_ESCALATION_ENABLED and OPS_RETRY_ENABLED both default to true when the env var is unset
// (the test env), so these tests exercise the enabled paths. The enabled=false downgrade takes the
// SAME canEscalate/canRetry→false branch that an `escalationOf`/`retryOf`-set task takes (tested below).

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

test('detectCause: needs_auth from status', () => {
  assert.equal(detectCause(mkResult({ status: 'needs_auth', summary: 'I need access to your Gmail to answer that.' }), false), 'needs_auth');
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

test('decide: stronger-model causes escalate on a normal first-look task', () => {
  for (const cause of ['timeout', 'tool_errors', 'fidelity_suppressed'] as const) {
    assert.equal(decide(cause, mkTask()).action, 'escalate', `${cause} should escalate`);
  }
});

test('decide: transient lane causes take the cheap retry, not the expensive escalation', () => {
  // OPS_RETRY_ENABLED defaults true in the test env, so llm_error/rate_limited prefer the cheap
  // same-role retry over a stronger-model escalation (which can't fix an infrastructure blip).
  for (const cause of ['llm_error', 'rate_limited'] as const) {
    assert.equal(decide(cause, mkTask()).action, 'retry', `${cause} should retry`);
  }
});

test('decide: a retry leg (retryOf set) ladders to escalation on a RESEARCHABLE miss, never retries again', () => {
  // The ladder: a retry that comes back a researchable failure earns the ONE strong second look.
  for (const cause of ['timeout', 'tool_errors', 'fidelity_suppressed'] as const) {
    assert.equal(decide(cause, mkTask({ retryOf: 't1' })).action, 'escalate', `${cause} on a retry leg should escalate`);
  }
  // But a fresh transient error on the retry leg does NOT escalate (infra can't be fixed by a model) and
  // cannot retry again — it gives up to today's transient beat.
  assert.equal(decide('llm_error', mkTask({ retryOf: 't1' })).action, 'none');
  assert.equal(decide('rate_limited', mkTask({ retryOf: 't1' })).action, 'none');
});

test('decide: escalationOf set → never escalates OR retries again (one per attempt)', () => {
  assert.equal(decide('fidelity_suppressed', mkTask({ escalationOf: 't1' })).action, 'none');
  assert.equal(decide('timeout', mkTask({ escalationOf: 't1' })).action, 'none');
  assert.equal(decide('llm_error', mkTask({ escalationOf: 't1' })).action, 'none');
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

test('splitMiss: RESEARCH_GAP → escalate with directive; escalationOf blocks it', async () => {
  const ok = await splitMiss(mkResult(), mkTask(), fakeLlm('{"verdict":"RESEARCH_GAP","missing":[],"directive":"check the attachments, not just the email bodies"}') as never);
  assert.equal(ok.action, 'escalate');
  assert.match(ok.researchDirective ?? '', /attachments/);
  const blocked = await splitMiss(mkResult(), mkTask({ escalationOf: 't1' }), fakeLlm('{"verdict":"RESEARCH_GAP","missing":[],"directive":"go deeper"}') as never);
  assert.equal(blocked.action, 'none');
});

test('splitMiss: RESEARCH_GAP on a RETRY leg still escalates (the ladder)', async () => {
  const d = await splitMiss(mkResult(), mkTask({ retryOf: 't1' }), fakeLlm('{"verdict":"RESEARCH_GAP","missing":[],"directive":"go deeper"}') as never);
  assert.equal(d.action, 'escalate');
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

// ── buildEscalationMetaPrompt ─────────────────────────────────────────────────

test('buildEscalationMetaPrompt: carries the ask, tool ledger, digest, and directive', () => {
  const result = mkResult({
    debrief: mkDebrief({
      steps: 3,
      toolsRun: [{ name: 'search_email', argsSummary: '{"terms":["invoice"]}', ok: true, resultPreview: 'found 2 threads' }],
      corpus: ['TOOL search_email RESULT:\nthread A ...'],
    }),
  });
  const prompt = buildEscalationMetaPrompt(mkTask({ metaPrompt: 'look in their inbox' }), result, { cause: 'empty_miss', action: 'escalate', researchDirective: 'try the attachments too', deterministic: false });
  assert.match(prompt, /second look/i);
  assert.match(prompt, /find the date on that invoice/);
  assert.match(prompt, /look in their inbox/);
  assert.match(prompt, /search_email/);
  assert.match(prompt, /3 steps, 1 tool calls/);
  assert.match(prompt, /try the attachments too/);
});

test('buildEscalationMetaPrompt: fidelity cause carries the ungrounded list + withheld draft', () => {
  const result = mkResult({
    summary: 'NO RESULT: ...',
    debrief: mkDebrief({ failure: { cause: 'fidelity_suppressed', ungrounded: ['currency: $5,000', 'name: Rick Blanchard'], withheldSummary: 'the total is $5,000 per Rick Blanchard' } }),
  });
  const prompt = buildEscalationMetaPrompt(mkTask(), result, { cause: 'fidelity_suppressed', action: 'escalate', deterministic: true });
  assert.match(prompt, /could not confirm/i);            // terse "why" line
  assert.match(prompt, /verify or CORRECT/i);            // the concrete re-verify directive owns the checklist
  assert.match(prompt, /currency: \$5,000/);             // …with the ungrounded facts numbered
  assert.match(prompt, /UNVERIFIED/);
  assert.match(prompt, /the total is \$5,000 per Rick Blanchard/);
});

test('buildEscalationMetaPrompt: attempt≥2 tells the model the user already clarified', () => {
  const prompt = buildEscalationMetaPrompt(mkTask({ attempt: 2 }), mkResult({ debrief: mkDebrief({ corpus: ['TOOL search_email RESULT:\nnothing'] }) }), { cause: 'empty_miss', action: 'escalate', deterministic: false });
  assert.match(prompt, /ALREADY answered a clarifying question/i);
});

test('buildEscalationMetaPrompt: a huge corpus is bounded (middle dropped)', () => {
  // 20 entries × ~1930 chars (post per-entry cap) ≈ 38k > the 24k digest cap → middle-drop kicks in.
  const big = Array.from({ length: 20 }, (_, i) => `TOOL t${i} RESULT:\n` + 'y'.repeat(4000));
  const result = mkResult({ debrief: mkDebrief({ steps: 8, toolsRun: [], corpus: big }) });
  const prompt = buildEscalationMetaPrompt(mkTask(), result, { cause: 'empty_miss', action: 'escalate', deterministic: false });
  assert.ok(prompt.length < 30_000, `prompt too large: ${prompt.length}`);
  assert.match(prompt, /tool result\(s\) omitted/i);
  // The first and last entries (framing + most refined attempt) survive.
  assert.match(prompt, /TOOL t0 RESULT/);
  assert.match(prompt, /TOOL t19 RESULT/);
});

test('buildEscalationMetaPrompt: a timeout gets a concrete "continue from here" directive', () => {
  const result = mkResult({
    debrief: mkDebrief({
      steps: 5,
      toolsRun: [
        { name: 'search_email', argsSummary: '{"terms":["invoice"]}', ok: true, resultPreview: 'found 3 threads' },
        { name: 'read_email', argsSummary: '{"id":"abc"}', ok: true, resultPreview: 'the attached statement ...' },
      ],
      corpus: ['TOOL read_email RESULT:\nthe attached statement ...'],
    }),
  });
  const prompt = buildEscalationMetaPrompt(mkTask({ kind: 'document_read' }), result, { cause: 'timeout', action: 'escalate', deterministic: true });
  assert.match(prompt, /5 steps/);             // names how far it got
  assert.match(prompt, /read_email/);           // names the last tool it was on
  assert.match(prompt, /do NOT restart/i);      // the "continue, don't start over" steer (there IS a trail)
  assert.match(prompt, /args are in the tagged tool log/i); // last-tool args stay in the tagged ledger, not the trusted directive
});

test('buildEscalationMetaPrompt: tool_errors names the failed routes AND the untried ones', () => {
  const result = mkResult({
    summary: 'no result',
    debrief: mkDebrief({
      steps: 2,
      toolsRun: [{ name: 'search_email', argsSummary: '{"terms":["invoice"]}', ok: false, resultPreview: 'error: gmail timeout' }],
      corpus: ['TOOL search_email RESULT:\nerror: gmail timeout'],
      failure: { cause: 'tool_errors' },
    }),
  });
  const prompt = buildEscalationMetaPrompt(mkTask({ kind: 'document_read' }), result, { cause: 'tool_errors', action: 'escalate', deterministic: true });
  assert.match(prompt, /routes failed on the first pass: search_email/);
  assert.match(prompt, /Untried routes/);
  // A document_read tool that was never called shows up as a lead (e.g. the attachment route).
  assert.match(prompt, /read_attachment/);
  // But a pure side-effect tool (schedule_followup is in document_read's set) is NEVER suggested as a
  // research route — it can't advance an answer.
  assert.doesNotMatch(prompt, /schedule_followup/);
});

test('buildEscalationMetaPrompt: an empty trail drops the tool blocks AND the "continue from the trail" steer', () => {
  // A fast failure that died before any tool returned: no ledger, no corpus. The tagged tool blocks
  // must NOT render (no "(no tools ran)" scaffolding), AND the why/job lines must NOT tell the model to
  // "continue from the trail above" / "do NOT restart" when there is no trail (a self-contradiction).
  const result = mkResult({ status: 'error', summary: 'ran into a problem completing that', debrief: mkDebrief({ steps: 1 }) });
  const prompt = buildEscalationMetaPrompt(mkTask({ kind: 'document_read' }), result, { cause: 'timeout', action: 'escalate', deterministic: true });
  assert.doesNotMatch(prompt, /first_pass_tool_log/);
  assert.doesNotMatch(prompt, /first_pass_tool_output/);
  assert.match(prompt, /no tool trail/i);
  assert.match(prompt, /what the user asked/);         // the ask + directive still render
  assert.doesNotMatch(prompt, /trail above/i);          // no "continue from the trail above" when there's none
  assert.doesNotMatch(prompt, /do NOT restart/i);       // …and no "don't restart" either
  assert.match(prompt, /start the research yourself/i); // instead: do the research from scratch
});

// ── looksLikeToolError (debrief tagging heuristic) ────────────────────────────

test('looksLikeToolError: real errors are errors, clean "found nothing" is not', () => {
  assert.equal(looksLikeToolError('tool search_email error: timeout'), true);
  assert.equal(looksLikeToolError('error: upstream rejected the API key (401) — invalid'), true);
  assert.equal(looksLikeToolError('GMAIL_NOT_CONNECTED'), true);
  assert.equal(looksLikeToolError('no matching emails found'), false);
  assert.equal(looksLikeToolError('no follow-ups on record yet'), false);
  assert.equal(looksLikeToolError('matched entry on record: order #4182\nitems: 3'), false);
  assert.equal(looksLikeToolError(''), false);
  // Legit tool RESULTS that merely CONTAIN an error-ish word mid-line must not be mis-tagged (the
  // word is only an error indicator when it ANCHORS the line) — else >half tripping it would flip an
  // empty_miss to tool_errors and skip the ask_user/INFO_HOLE path.
  assert.equal(looksLikeToolError('- id=abc | from: sender | subj: Request rejected by the vendor'), false);
  assert.equal(looksLikeToolError('the review failed to surface any real problems'), false);
  assert.equal(looksLikeToolError('status: invalid address on file'), false);
});
