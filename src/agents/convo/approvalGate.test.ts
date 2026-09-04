// The approval gate: a delegation that would have the ENGINE act in the world does not start when
// it is built. It is parked in `ops_tasks` at `pending_approval`, written to `agent_prefs` beside
// pending_clarification, and she asks in one line whether to go ahead — through the same
// system-note re-ask the unkept-promise guard uses, because the holding line she already wrote
// ("on it, emailing them now") is a claim about work that must not have started.
//
// End-to-end through processConvoResult with the model faked at the lane seam (the pattern of
// routingGate.test.ts): the DB is the real ephemeral SQLite, so the row, the pref and the prompt
// section the NEXT turn reads are all the live ones.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, getActiveOps } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { listPendingApprovals, getOpsTask } from '../../db/repositories/opsTasks.js';
import { getPreference } from '../../db/repositories/memory.js';
import { buildContextBlock } from '../../memory/dossier.js';
import { approvalAskFallback } from '../ops/sideEffects.js';
import type { LlmResult, LlmToolCall, LlmRequest } from '../../llm/types.js';

const ACT_ASK = 'email my landlord that rent is late';
const READ_ASK = 'how much does a flight to bali cost in november';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 90,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegate(request: string, effect?: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'general', request, ...(effect ? { effect } : {}) } };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555820${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

/** The re-ask seam: a turn context whose `call` records what it was asked and answers as she would. */
function reasker(bubbles: string[]) {
  const seen: LlmRequest[] = [];
  const turn: ConvoTurnContext = {
    system: 'persona',
    messages: [{ role: 'user', content: 'hey' }],
    tools: [],
    call: async (req: LlmRequest) => { seen.push(req); return makeResult(bubbles); },
  };
  return { turn, seen };
}

function receipt(label: string): Record<string, unknown> | undefined {
  const ev = getTraces().find(e => e.label === label);
  return ev ? ((ev.detail ?? {}) as Record<string, unknown>) : undefined;
}

async function withGate<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.OPS_APPROVAL_GATE;
  if (value === undefined) delete process.env.OPS_APPROVAL_GATE;
  else process.env.OPS_APPROVAL_GATE = value;
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.OPS_APPROVAL_GATE;
    else process.env.OPS_APPROVAL_GATE = prior;
  }
}

// ── an action is parked and asked about ──────────────────────────────────────

test("an act delegation never starts: it is parked, asked about, and the next turn's prompt says so", async () => {
  const a = args(ACT_ASK);
  const { turn, seen } = reasker(['want me to send that to your landlord?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [delegate(ACT_ASK, 'act')]),
    turn,
  });

  // NOTHING to kick off: index.ts starts a run only from `delegatedTask`, so a null one is the park.
  assert.equal(out.delegatedTask, null, 'no task goes back for kickoff');
  assert.equal(getActiveOps(a.chatId).length, 0, 'and nothing is marked in flight');

  // The row outlives the process, at the one status the stranded sweep ignores.
  const parked = listPendingApprovals(a.chatId);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].status, 'pending_approval');
  assert.equal(parked[0].request, ACT_ASK);
  assert.equal(parked[0].chatId, a.chatId, 'the row is keyed by chat, like every other ops_tasks row');
  const task = parked[0].meta.task as Record<string, unknown>;
  assert.equal(task.effect, 'act', 'the whole task is serialized, ready to run on a yes');
  assert.equal(task.request, ACT_ASK);
  assert.deepEqual(task.approval, { askedAt: parked[0].startedAt });

  // The pref beside pending_clarification — what the next turn's resolution reads.
  const pref = await getPreference<{ taskId: string; request: string; kind: string; askedAt: number }>(a.handle, 'pending_approval');
  assert.ok(pref, 'the pref is written');
  assert.equal(pref!.taskId, parked[0].id);
  assert.equal(pref!.request, ACT_ASK);
  assert.equal(pref!.kind, 'general');
  assert.equal(typeof pref!.askedAt, 'number');

  // She ASKED, in her own words, and the holding line she wrote first is gone.
  assert.equal(seen.length, 1, 'exactly one extra call');
  const note = String(seen[0].messages.at(-1)?.content ?? '');
  assert.match(note, /^SYSTEM: you were about to have the engine email my landlord that rent is late/);
  assert.match(note, /no tool calls/);
  assert.equal(out.text, 'want me to send that to your landlord?');
  assert.doesNotMatch(out.text ?? '', /emailing them now/);

  assert.deepEqual(receipt('ops:approval'), { decision: 'requested', trigger: 'both', taskId: parked[0].id });
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'reasked' });

  // And the next turn is told the ask is open — the whole reason the park is durable.
  const block = await buildContextBlock(a.handle, 'yes');
  assert.match(block, /## You asked them to approve an action/);
  assert.match(block, /email my landlord that rent is late/);
  assert.match(block, /has NOT started/);
});

test('a read-tagged delegation whose request would act is parked by the lexicon alone', async () => {
  const ask = 'send my landlord an email about the rent being late';
  const a = args(ask);
  const { turn } = reasker(['you want me to send that email?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['looking into it'], [delegate(ask, 'read')]),
    turn,
  });
  assert.equal(out.delegatedTask, null, 'the model said read; the words said otherwise');
  assert.equal(listPendingApprovals(a.chatId).length, 1);
  assert.equal(receipt('ops:approval')?.trigger, 'lexicon');
});

// ── a look is untouched ──────────────────────────────────────────────────────

test('a research ask kicks off exactly as before, with a not_needed receipt', async () => {
  const a = args(READ_ASK);
  const { turn, seen } = reasker(['unused']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
    turn,
  });
  assert.ok(out.delegatedTask, 'the look goes out');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(out.delegatedTask!.approval, undefined);
  assert.equal(out.text, 'checking flights now', 'her own holding line ships');
  assert.equal(seen.length, 0, 'no re-ask is spent');
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no row');
  assert.equal(await getPreference(a.handle, 'pending_approval'), undefined, 'no pref');
  assert.deepEqual(receipt('ops:approval'), { decision: 'not_needed', trigger: 'none' });
  assert.equal(receipt('convo:approval_ask'), undefined);
});

test('quoted words inside a request are data — a song title does not park a lookup', async () => {
  const ask = "search for the song 'send me an angel'";
  const a = args(ask);
  const { turn } = reasker(['unused']);
  const out = await processConvoResult({ ...a, res: makeResult(['looking that up'], [delegate(ask)]), turn });
  assert.ok(out.delegatedTask, 'still just a lookup');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(receipt('ops:approval')?.decision, 'not_needed');
});

test('the park stands the routing floor down — it must never replace a parked ask with a live look', async () => {
  // The floor fires on a turn with no delegation, and a parked turn has none by construction. Left
  // alone it would force a look for the same message the user has not authorized yet.
  const ask = 'how much do i owe, and pay the landlord the balance';
  const a = args(ask);
  const { turn } = reasker(['want me to pay that off?']);
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ask, 'act')]), turn });
  assert.equal(out.delegatedTask, null, 'nothing was forced out behind the parked ask');
  assert.equal(receipt('convo:routing_gate'), undefined, 'the floor never even evaluated');
});

// ── the ask, when the model cannot deliver it ────────────────────────────────

test('a re-ask that comes back empty or with a tool call falls back to one code line', async () => {
  const a = args(ACT_ASK);
  const turn: ConvoTurnContext = {
    system: 'persona', messages: [], tools: [],
    call: async () => makeResult([], [delegate(ACT_ASK, 'act')]),
  };
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  assert.equal(out.delegatedTask, null, 'still parked');
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback' });
  assert.equal(listPendingApprovals(a.chatId).length, 1, 'the park does not depend on the ask landing');
});

test('a re-ask that throws still asks — the code line ships and the row stands', async () => {
  const a = args(ACT_ASK);
  const turn: ConvoTurnContext = {
    system: 'persona', messages: [], tools: [],
    call: async () => { throw new Error('lane down'); },
  };
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback' });
  assert.equal(listPendingApprovals(a.chatId).length, 1);
});

test('with no turn context at all (a caller that passes none) the fallback carries the ask', async () => {
  const a = args(ACT_ASK);
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]) });
  assert.equal(out.delegatedTask, null);
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback' });
});

// ── the off path ─────────────────────────────────────────────────────────────

test('OPS_APPROVAL_GATE=off: an action kicks off exactly as today — no row, no pref, no ask, no receipt', async () => {
  const a = args(ACT_ASK);
  const { turn, seen } = reasker(['unused']);
  const out = await withGate('off', () => processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [delegate(ACT_ASK, 'act')]),
    turn,
  }));

  const task = out.delegatedTask;
  assert.ok(task, 'the task goes back for kickoff, as it would have before any of this existed');
  // The whole object, field by field: the gate off must change NOTHING about the task but the one
  // new data field the tool arg feeds.
  assert.deepEqual(task, {
    id: task!.id,
    chatId: a.chatId,
    agentHandle: a.handle,
    kind: 'general',
    request: ACT_ASK,
    effect: 'act',
    metaPrompt: `The user asked: "${ACT_ASK}". Work out what they actually need, use whatever tools fit (the web, their email if connected, your own past chats), and return a concrete, useful answer.`,
    heldMemory: undefined,
    memoryHits: 0,
    addressHint: undefined,
    dealHint: undefined,
    replyToMessageId: undefined,
    attempt: 1,
    originConfidence: 90,
    media: undefined,
    recalledAgeMs: undefined,
    createdAt: task!.createdAt,
    // Set after the loop, off the line that shipped — the composer continues straight from it.
    holdingText: 'on it, emailing them now',
    holdingAt: task!.holdingAt,
  });
  assert.equal(task!.approval, undefined, 'no handshake happened');
  assert.equal(seen.length, 0, 'no re-ask');
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no row');
  assert.equal(await getPreference(a.handle, 'pending_approval'), undefined, 'no pref');
  assert.equal(receipt('ops:approval'), undefined, 'and the gate files nothing when it is not there');
  assert.equal(receipt('convo:approval_ask'), undefined);
  // Her own holding line ships untouched (the salvage floor keeps the holding-shaped opener).
  assert.match(out.text ?? '', /emailing them now/);
});

test('OPS_APPROVAL_GATE=off: a read delegation is byte-identical to the flag-on read path', async () => {
  const on = args(READ_ASK);
  const onOut = await withGate(undefined, () => processConvoResult({
    ...on, res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
  }));
  const off = args(READ_ASK);
  const offOut = await withGate('off', () => processConvoResult({
    ...off, res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
  }));
  // Everything but the four fields a second run cannot repeat (the id, the two chat keys and the
  // two clocks) has to be the same object either side of the flag.
  const shape = (t: typeof onOut.delegatedTask) =>
    ({ ...t, id: 'x', chatId: 'x', agentHandle: 'x', createdAt: 0, holdingAt: 0 });
  assert.deepEqual(shape(offOut.delegatedTask), shape(onOut.delegatedTask));
  assert.equal(offOut.text, onOut.text);
});

test('the tool arg is still accepted and coerced with the gate off', async () => {
  for (const junk of ['banana', '', 'READ']) {
    const a = args(READ_ASK);
    const out = await withGate('off', () => processConvoResult({
      ...a, res: makeResult(['on it'], [delegate(READ_ASK, junk)]),
    }));
    assert.equal(out.delegatedTask!.effect, 'read', junk);
  }
  // ...and an 'act' tag is still read as one, so a flip of the flag needs no other change.
  const a = args(ACT_ASK);
  const out = await withGate('off', () => processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'ACT')]),
  }));
  assert.equal(out.delegatedTask!.effect, 'act');
});

// ── the row's own clock ──────────────────────────────────────────────────────

test('the parked row carries the ask time as its clock, and nothing settles it here', async () => {
  const a = args(ACT_ASK);
  const before = Date.now();
  const { turn } = reasker(['go ahead?']);
  await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  const row = getOpsTask(listPendingApprovals(a.chatId)[0].id);
  assert.ok(row);
  assert.ok(row!.startedAt >= before && row!.startedAt <= Date.now(), 'askedAt is the row clock');
  assert.equal(row!.settledAt, null, 'a question waiting is not a settled row');
  assert.equal(row!.kind, 'general');
});
