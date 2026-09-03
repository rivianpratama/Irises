// Coverage for the MEMORY-AWARE routing gate — the never-event from the 2026-09-03 correspondence
// run. Asked "how many days till dana's wedding again", Convo replied "39 days / oct 12, you're
// doing the toast", read straight off a held note. The gate saw only the text ("how many" → a data
// question), discarded that correct answer, force-delegated, and the engine — which holds none of
// her memory — came back with "which dana is this?".
//
// So two things are pinned here, on one live path each:
//   • the gate STANDS DOWN when something she holds touches the ask and she wrote an answer off it;
//   • and when a delegation does happen, the brief carries her own words for those things, so the
//     engine can never have to ask which Dana.
//
// The relevance router is the real one (memory/relevance.ts) built off real held items, so the hit
// kinds and labels under test are the ones a live turn produces. Runs end-to-end against the
// ephemeral DB backend; voiceInstant degrades to its static floor when the LLM call fails, so
// processConvoResult runs for real, exactly as refusalFloor.test.ts does.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { buildTurnRelevance, threadHit, type TurnRelevance } from '../../memory/relevance.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, markOpsStart } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { runTask } from '../ops/client.js';
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';
import type { TurnTraceTurnInputs } from '../../diagnostics/turnTrace.js';

// The live turn, verbatim. `needsGrounding` reads it 'yes' on "how many".
const ASK = "how many days till dana's wedding again";
// Convo's own parsed reply from that turn.
const ANSWER = ['39 days', "oct 12, you're doing the toast"];
// The two things the turn receipt showed her holding about it — a medium note and a section of her
// long dossier.
const NOTE = "dana's wedding oct 12, rivian is giving a toast";
const LONG = "## Family\nRivian's sister Dana's wedding is Oct 12, he's doing a toast";

/** The brief the gate has always written for a forced look — pinned verbatim, because "byte-
 *  identical with nothing held" and "byte-identical with the flag off" are both claims about it. */
const gateBrief = (ask: string) => `The user asked: "${ask}". This needs real, grounded data (the web, their own email, or their own past chats) — do NOT answer from general knowledge. Use the right tools and return only grounded facts; if you can't find it, say so.`;

/** The router as a live turn builds it: over what the memory loaders actually returned. */
function relevance(turnText: string, held: { notes?: string[]; longSections?: string[]; directives?: string[] } = {}): TurnRelevance {
  return buildTurnRelevance(turnText, {
    medium: {
      notes: held.notes ?? [],
      facts: {},
      directives: (held.directives ?? []).map((text, i) => ({ id: `d${i}`, text, createdAt: 0 })),
    },
    longSections: held.longSections ?? [],
  });
}

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 95,
    tool_calls: null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function args(textToSend = ASK) {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555800${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

/** The gate's own receipt for the turn just run. */
function gateReceipt(): Record<string, unknown> {
  const ev = getTraces().find(e => e.label === 'convo:routing_gate');
  assert.ok(ev, 'convo:routing_gate was recorded');
  return (ev.detail ?? {}) as Record<string, unknown>;
}

// ── the gate stands down ─────────────────────────────────────────────────────

test('she holds the answer and wrote it, so the gate stands down and her words ship', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
  });
  assert.ok(!out.delegatedTask, 'no forced look — she already answered it');
  assert.equal(out.text, ANSWER.join('\n---\n'), 'her reply ships unchanged, bubble for bubble');
  const detail = gateReceipt();
  assert.equal(detail.decision, 'skipped_memory_hit');
  assert.deepEqual(detail.hitKinds, ['note', 'long'], 'both channels that touched it, best first');
  // The router's own names for the two: a note is its own text, a dossier section is its heading.
  assert.deepEqual(detail.hitLabels, [NOTE, 'Family']);
  assert.equal(detail.salvaged, false, 'nothing was salvaged because nothing was discarded');
});

// ── and every reason it still fires ──────────────────────────────────────────

test('nothing of hers touches the ask, so the gate forces the look exactly as before', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    // A full memory stack in front of her with nothing in it about the message in hand.
    relevance: relevance(ASK, { notes: ['the cedar cabin electrician is booked for thursday'] }),
  });
  assert.ok(out.delegatedTask, 'the un-grounded answer is discarded for a real look');
  assert.equal(out.delegatedTask!.request, ASK);
  const detail = gateReceipt();
  assert.equal(detail.decision, 'delegated');
  assert.deepEqual(detail.hitKinds, []);
});

test('a directive or a thread offer is not something she holds, so the gate still fires', async () => {
  // A directive is a standing instruction about HOW she answers; a thread offer is what the thread
  // engine chose for this turn (it reaches the prompt through its own door, convo/client.ts). Both
  // touch the ask lexically here, and neither may buy an un-grounded answer a pass.
  const turn = relevance(ASK, { directives: ["dana's wedding is a sore subject, go gentle"] });
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: { ...turn, hits: [threadHit(turn, "dana's wedding"), ...turn.hits] },
  });
  assert.ok(out.delegatedTask, 'still forced');
  assert.deepEqual(gateReceipt().hitKinds, ['thread', 'directive'], 'the receipt says why it did not stand down');
});

test('an empty reply, or one that went off to do work, is not an answer worth keeping', async () => {
  const held = { notes: [NOTE] };
  const silent = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, held) });
  assert.ok(silent.delegatedTask, 'nothing was answered, so the look still has to happen');
  assert.equal(gateReceipt().decision, 'delegated');

  const working = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER, [{ name: 'send_reaction', input: { type: 'love' } }]),
    relevance: relevance(ASK, held),
  });
  assert.ok(working.delegatedTask, 'a tool-calling turn is already doing something — the gate does not read its text as the answer');
  assert.equal(gateReceipt().decision, 'delegated');
});

test('CONVO_ROUTING_GATE_MEMORY_AWARE=off puts the text-only gate back', async () => {
  process.env.CONVO_ROUTING_GATE_MEMORY_AWARE = 'off';
  try {
    const out = await processConvoResult({
      ...args(),
      res: makeResult(ANSWER),
      relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
    });
    assert.ok(out.delegatedTask, 'the same forced delegation as before this existed');
    assert.equal(out.delegatedTask!.metaPrompt, gateBrief(ASK), 'and the same brief, byte for byte');
    const detail = gateReceipt();
    assert.equal(detail.decision, 'delegated');
    assert.deepEqual(detail.hitKinds, ['note', 'long'], 'the hits are still reported, so the flag can be measured before it is trusted');
  } finally {
    delete process.env.CONVO_ROUTING_GATE_MEMORY_AWARE;
  }
});

// ── the receipt fires on every evaluation, not only when the gate fires ──────

test('a message that needs no grounding still leaves a receipt', async () => {
  const out = await processConvoResult({
    ...args('thanks, that helps a lot'),
    res: makeResult(['anytime']),
    relevance: relevance('thanks, that helps a lot', { notes: [NOTE] }),
  });
  assert.ok(!out.delegatedTask);
  assert.equal(out.text, 'anytime');
  assert.equal(gateReceipt().decision, 'not_needed');
});

test('the same ask already running leaves its own receipt, and is never stacked on', async () => {
  const a = args();
  markOpsStart(a.chatId, randomUUID(), { kind: 'general', request: ASK });
  const out = await processConvoResult({ ...a, res: makeResult(ANSWER), relevance: relevance(ASK, { notes: [NOTE] }) });
  assert.ok(!out.delegatedTask, 'the running task’s follow-up is genuinely coming');
  assert.equal(gateReceipt().decision, 'skipped_in_flight');
});

// ── and when a delegation DOES happen, it carries what she holds ─────────────

/** The block, as the ops brief carries it — her own rendered text for each thing, as data. */
const heldBlock = (lines: string[]) => `What she already holds about this:\n<held_memory>\n${lines.map(l => `- ${l}`).join('\n')}\n</held_memory>`;
/** Her long-doc section as the memory stack rendered it, flattened onto one line. */
const LONG_LINE = "## Family Rivian's sister Dana's wedding is Oct 12, he's doing a toast";

test('a forced look carries her own words, so the engine can never ask which dana', async () => {
  const out = await processConvoResult({
    ...args(),
    // No answer of her own, so the look genuinely has to happen — and it goes out knowing who Dana is.
    res: makeResult([]),
    relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
  });
  assert.ok(out.delegatedTask);
  assert.equal(out.delegatedTask!.metaPrompt, `${gateBrief(ASK)}\n\n${heldBlock([NOTE, LONG_LINE])}`);
  assert.equal(out.delegatedTask!.memoryHits, 2, 'and the count rides along for the kickoff receipt');
});

test('with nothing held, the forced brief is byte-identical to what it always was', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult([]),
    relevance: relevance(ASK, { notes: ['the cedar cabin electrician is booked for thursday'] }),
  });
  assert.equal(out.delegatedTask!.metaPrompt, gateBrief(ASK));
  assert.equal(out.delegatedTask!.memoryHits, 0);
});

test('the model’s OWN delegate_to_ops brief carries it too, after the model’s instruction', async () => {
  // The brief the model wrote stays the primary instruction (ops/client.ts labels it that way);
  // what she holds follows it as context.
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['lemme pull the exact date'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'get the exact date off her calendar' } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
  });
  assert.equal(out.delegatedTask!.metaPrompt, `get the exact date off her calendar\n\n${heldBlock([NOTE])}`);
  assert.equal(out.delegatedTask!.memoryHits, 1);
});

test('CONVO_ROUTING_GATE_MEMORY_AWARE=off carries nothing into either brief', async () => {
  process.env.CONVO_ROUTING_GATE_MEMORY_AWARE = 'off';
  try {
    const forced = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, { notes: [NOTE] }) });
    assert.equal(forced.delegatedTask!.metaPrompt, gateBrief(ASK));
    const model = await processConvoResult({
      ...args(),
      res: makeResult(['one sec'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'get the exact date off her calendar' } }]),
      relevance: relevance(ASK, { notes: [NOTE] }),
    });
    assert.equal(model.delegatedTask!.metaPrompt, 'get the exact date off her calendar');
    assert.equal(model.delegatedTask!.memoryHits, 0);
  } finally {
    delete process.env.CONVO_ROUTING_GATE_MEMORY_AWARE;
  }
});

test('a delegation the MODEL made never re-enters the gate, so there is no second receipt', async () => {
  // The structural fence: `delegatedTask` being set is what makes the whole block skip, and a turn
  // with no evaluation must claim no decision rather than a defaulted one.
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['lemme pull that up'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'find the date' } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
  });
  assert.ok(out.delegatedTask);
  assert.equal(getTraces().find(e => e.label === 'convo:routing_gate'), undefined, 'the gate was never evaluated');
});

// ── the decision on the turn receipt ────────────────────────────────────────

/** The smallest honest `trace` a caller can hand in — the receipt's other fields are pinned by
 *  turnTrace.test.ts; this is only here so the gate's decision has somewhere to land. */
const traceInputs = (): TurnTraceTurnInputs => ({
  prompt: { system: 'x', sections: [], personaChars: 0, anchorChars: 0 },
  messages: [],
  gates: {
    threads: null,
    memory: { shortHotLook: 'none', hits: [], blocks: {} },
    extras: { updateNote: false, introWeave: false, activeOps: 0 },
  },
  hits: [],
});

test('the gate’s decision rides the turn receipt, and only when the gate ran', async () => {
  const stood = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: relevance(ASK, { notes: [NOTE] }),
    trace: traceInputs(),
  });
  assert.equal(stood.turnTrace!.outcome.routingGate, 'skipped_memory_hit');

  const forced = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, {}), trace: traceInputs() });
  assert.equal(forced.turnTrace!.outcome.routingGate, 'delegated');

  // A turn the gate never reached claims nothing rather than a defaulted decision.
  const modelLed = await processConvoResult({
    ...args(),
    res: makeResult(['one sec'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
    trace: traceInputs(),
  });
  assert.equal('routingGate' in modelLed.turnTrace!.outcome, false);
});

// ── the far end of the brief ─────────────────────────────────────────────────
// The kickoff receipt is where a live round reads back whether a look went out blind. Same stub-
// engine pattern as ops/walledUrls.test.ts, kept here because it is the other end of the block above.

test('ops:kickoff says how much of her memory rode along', async () => {
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { return 'ANSWER: oct 12\nSOURCE: her calendar\nFLAGS: none'; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  const task = { id: 't1', chatId: 'c1', agentHandle: '+15558000000', kind: 'general' as const, request: ASK, metaPrompt: 'brief', attempt: 1, createdAt: Date.now() };
  resetEngineBackendCache(engine);
  try {
    clearTraces();
    await runTask({ ...task, memoryHits: 2 });
    assert.equal((getTraces().find(e => e.label === 'ops:kickoff')!.detail as Record<string, unknown>).memoryHits, 2);
    // A look that carried nothing reports zero, not nothing: "the engine was handed none of her
    // memory" has to be a reading, not an absence.
    clearTraces();
    await runTask(task);
    assert.equal((getTraces().find(e => e.label === 'ops:kickoff')!.detail as Record<string, unknown>).memoryHits, 0);
  } finally {
    resetEngineBackendCache(undefined);
  }
});
