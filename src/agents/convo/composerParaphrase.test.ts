// Regression coverage for the "composer-paraphrase" double-say fix in processConvoResult.
//
// Bug: when the model wrote SUBSTANTIVE answer content AND called delegate_to_ops in the same
// envelope, processConvoResult shipped the full text (SEND #1) and promoted it wholesale to
// delegatedTask.holdingText; the composer then re-answered the same facts from the real Ops result,
// and stripEchoedHolding only cuts a VERBATIM echo — so the paraphrase survived and the user heard
// the fact twice. The tail was also un-grounded (Convo is single-shot). Fix: when the MODEL builds
// the task, salvage only the safe holding-style opener (salvageHoldingText) as the shipped text and
// holdingText, discarding the un-grounded substantive tail — mirroring the routing-gate salvage.
//
// Exercised end-to-end against the in-memory DB backend (no Supabase creds), with voiceInstant
// degrading to its static floor when the LLM call fails — so processConvoResult runs for real.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { markOpsStart, __resetOpsCoordination } from '../../state/opsCoordination.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// Minimal engine stub (repo DI convention): captures remember() and accepts reminders.
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
function installStubEngine(): Array<{ chatId: string; handle: string; note: string }> {
  const remembered: Array<{ chatId: string; handle: string; note: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { return { id: 'r1', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember(chatId, handle, note) { remembered.push({ chatId, handle, note }); },
    async probe() { return { ok: true }; },
  };
  resetEngineBackendCache(engine);
  return remembered;
}


// Build an LlmResult the way callConvoLLM hands one to processConvoResult: `text` is the JSON bubble
// envelope (parseReply bridges it to legacy `\n---\n` wire text) and `toolCalls` are the parsed calls.
function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return {
    text: JSON.stringify(envelope),
    toolCalls,
    stopReason: 'end_turn',
    provider: 'anthropic',
    model: 'test',
  };
}

function delegate(request: string, address?: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'web_research', request, address: address ?? null, meta_prompt: null } };
}

function schedule(instruction: string, fireAtIso: string): LlmToolCall {
  return { name: 'schedule_automation', input: { instruction, schedule_kind: 'once', fire_at: fireAtIso, timezone: 'America/Chicago', title: null, needs_ops: false, ops_kind: null } };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
  };
};

test('substantive answer + delegate: shipped text drops the un-grounded claim; holdingText equals it', async () => {
  const a = baseArgs();
  // The exact bug shape: a genuine holding opener, then an un-grounded owner assertion. The opener
  // is digit-free so salvage keeps it verbatim (salvageHoldingText rejects any bubble with a figure).
  const res = makeResult(
    ["pulling the owner up now", "owner's the Hendersons"],
    [delegate('owner of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "who owns 412 Maple?" });

  assert.ok(out.delegatedTask, 'a task was delegated');
  assert.ok(out.text, 'the turn is never silent');
  // The un-grounded substantive claim never ships.
  assert.doesNotMatch(out.text!, /henderson/i, 'the un-grounded owner claim was dropped');
  // Only the safe holding opener survives.
  assert.match(out.text!, /pulling the owner up now/i);
  // holdingText (the composer's "never retype" anchor + stripEchoedHolding key) equals the shipped
  // text (tag-free; there are no [[re:N]] tags here so they match verbatim).
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('pure holding text + delegate: shipped unchanged (whole draft salvages)', async () => {
  const a = baseArgs();
  const res = makeResult(
    ["lemme check", "one sec"],
    [delegate('inspection deadline on 900 Pine')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "what's my inspection deadline on 900 Pine?" });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, 'lemme check\n---\none sec', 'a pure-holding reply ships unchanged');
  assert.equal(out.delegatedTask!.holdingText, 'lemme check\n---\none sec');
});

test('delegate with NO safe opener: voiceInstant holding path still produces text', async () => {
  const a = baseArgs();
  // A substantive-only draft (no holding-shaped bubble) salvages nothing → salvage yields null →
  // the !textResponse voiceInstant holding line must still fire.
  const res = makeResult(
    ["owner's the Hendersons and the ARV is $410,000"],
    [delegate('owner and ARV of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "who owns 412 Maple and what's the ARV?" });

  assert.ok(out.delegatedTask);
  assert.ok(out.text && out.text.trim().length > 0, 'voiceInstant holding line filled the gap');
  assert.doesNotMatch(out.text!, /henderson|410,000/i, 'the un-grounded draft did not leak through');
  // holdingText tracks whatever actually shipped (the voiced holding line).
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('delegate with EMPTY bubbles: voiceInstant holding path produces text', async () => {
  const a = baseArgs();
  const res = makeResult([], [delegate('comps on 55 Birch')]);
  const out = await processConvoResult({ ...a, res, textToSend: 'pull comps on 55 Birch' });

  assert.ok(out.delegatedTask);
  assert.ok(out.text && out.text.trim().length > 0, 'never silent on a bare delegation');
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('multi-intent (pleasantry + delegate): the ack opener AND the holding line both ship, no data leaks', async () => {
  const a = baseArgs();
  // "you're welcome!" is a legit ack opener leading into a real holding bubble — Irises's own words
  // ship (the 2026-07-06 Fallfirm-override fix: model text is kept whenever safe, Fallfirm only
  // fills genuine gaps). The digits ("55 Birch") are the user's own words, so they're a safe echo.
  const res = makeResult(
    ["you're welcome!", "pulling comps on 55 Birch now"],
    [delegate('comps on 55 Birch')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'thanks, also pull comps on 55 Birch' });

  assert.ok(out.delegatedTask);
  assert.match(out.text!, /you'?re welcome/i, "Irises's own pleasantry survives");
  assert.match(out.text!, /pulling comps on 55 Birch now/i, 'her own holding line ships, not a generated one');
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test("persona-example holding text with the user's own address digits ships verbatim (no Fallfirm override)", async () => {
  const a = baseArgs();
  // The reported bug: Convo responds with a persona-compliant holding text; the old salvage killed it
  // (any-digit rule) and the later-returning Fallfirm line replaced Convo's response. Now the user's
  // own figures are a grounded echo and Irises's words ship untouched.
  const res = makeResult(
    ["okay that's a real question", 'pulling the comps on 412 Maple now'],
    [delegate('comps on 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'pull comps on 412 Maple' });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, "okay that's a real question\n---\npulling the comps on 412 Maple now",
    "Convo's own reply ships — Fallfirm never overrides a safe model-written holding text");
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('in-flight duplicate: no new task, and the un-grounded claim is salvaged away (no cross-turn double-say)', async () => {
  // The model re-delegates an ask ALREADY running; `if (suppressedDuplicate) continue` skips building
  // a new task, so the salvage's `modelDelegated && delegatedTask` guard would miss it — the inline
  // claim would ship AND the original in-flight task's composer would re-voice it later. The fix also
  // salvages on the suppressedDuplicate path; here the !textResponse still_on_it line fills the gap.
  __resetOpsCoordination();
  const a = baseArgs();
  markOpsStart(a.chatId, 'task-A', { kind: 'web_research', request: 'owner of 412 Maple' });
  const res = makeResult(
    ["the county records show it's owned by an LLC", "pulling the exact entity now"],
    [delegate('owner of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'who owns 412 maple?' });

  assert.equal(out.delegatedTask, null, 'the in-flight dup was suppressed — no second Ops run');
  assert.ok(out.text && out.text.trim().length > 0, 'never silent (still_on_it line)');
  assert.doesNotMatch(out.text!, /county records|owned by an llc|\bllc\b/i, 'the un-grounded claim never ships');
  __resetOpsCoordination();
});

test('schedule + delegate: the reminder confirmation survives (salvage must not swallow it)', async (t) => {
  installStubEngine();
  t.after(() => resetEngineBackendCache(undefined));
  // A turn that BOTH schedules and delegates: the model writes the reminder confirmation AND a holding
  // line. Salvage must NOT nuke the model's text (which would leave the reminder silently set) — the
  // action-bearing guard skips salvage so the confirmation ("9am") ships.
  const a = baseArgs();
  const fireAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const res = makeResult(
    ["got it, i'll remind you tomorrow at 9am", "pulling comps on 55 Birch now"],
    [schedule('remind them about 55 Birch', fireAt), delegate('comps on 55 Birch')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'remind me about 55 Birch tomorrow 9am and pull comps on it' });

  assert.ok(out.delegatedTask, 'the lookup was still delegated');
  assert.match(out.text!, /9am/i, 'the reminder confirmation was not swallowed by the delegation holding line');
  assert.match(out.text!, /pulling comps/i, 'the holding line for the lookup also shipped');
});
