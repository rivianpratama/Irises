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
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

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
