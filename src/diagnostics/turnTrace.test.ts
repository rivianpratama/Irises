// The per-turn receipt. One `turn:trace` per user-visible turn, carrying what was in front of the
// model (which prompt sections, how big, which gates fired, what the envelope emitted) and what
// came out of it (which bubbles, which tool calls) — names and NUMBERS only, because this detail
// persists for 30 days in diagnostic_turn_history.
//
// Three things these tests hold down, in order of what would hurt most if it broke:
//   1. the LEAK GUARD — a receipt that quietly carried prompt text would put the persona, the
//      internal weather block and the user's own dossier into a 30-day store;
//   2. it fires UNCONDITIONALLY — a garbled envelope and a turn that shipped nothing are exactly
//      the turns worth attributing, so they must file a receipt like any other;
//   3. the arithmetic is exhaustive — the measured sections add back up to the prompt they came
//      from (promptSections.ts owns that arithmetic; this only reuses it).
//
// The builders are pure, so most of this file is plain function calls. The two tests that run a
// whole Convo turn use the same no-LLM harness as bubbleReport.test.ts / silentTurn.test.ts: the
// plain reply path never reaches a voicer, so nothing here touches a provider.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildTurnTrace, buildTurnTraceDraft, describeStatusCoercions, recordTurnTrace,
  STATUS_COERCION_REASONS, TRACE_SECTIONS_CAP, TURN_TRACE_LABEL,
  type TurnTraceDraft, type TurnTraceOutcome, type TurnTraceTurnInputs,
} from './turnTrace.js';
import { getTraces, clearTraces } from './trace.js';
import { buildSystemPromptSections, processConvoResult, type ChatContext } from '../agents/convo/shared.js';
import { SECTION_IDS, sectionsTotalChars, isDynSection } from '../agents/convo/promptSections.js';
import { loadContext } from '../agents/loadContext.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../persona/status.js';
import { computeCycle } from '../persona/cycle.js';
import { computeCircadian } from '../persona/circadian.js';
import { buildBubbleReport } from '../pipeline/bubbleJson.js';
import { emptyMedia } from '../webhook/types.js';
import { __resetOpsCoordination } from '../state/opsCoordination.js';
import type { LlmResult, LlmToolCall } from '../llm/types.js';
import type { StoredMessage, UserProfile } from '../db/types.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A status exactly as the persona asks for it — every field valid, both threading fields the
 *  sanctioned "not this turn" null. Nothing here should read as a coercion. */
const GOOD_STATUS: Record<string, unknown> = {
  mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
  anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
  engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
  meta_prompt: 'they seem upbeat, keep it light', profile_note: 'warm, forward-looking',
  terminal_closure: false, thread_note: null, thread_outcome: null,
};

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 6), Date.UTC(2026, 0, 1)),
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 2, 0, 0), 'UTC'),
};

function affect(): AffectState {
  const emitted = coerceStatus(GOOD_STATUS)!;
  return { last: mergeStatus(emitted, COMPUTED, 0), moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] };
}

const PROFILE: UserProfile = {
  handle: '+15550001111', name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2,
};

const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: '+15550001111', at: Date.UTC(2026, 0, 6, 1, 40) },
  { role: 'assistant', content: 'checking now', at: Date.UTC(2026, 0, 6, 1, 42) },
];

const CONTEXT_BLOCK = '## Who you are talking to\nSam, three months in. Runs a nursery.\n\n<user_notes>\nthe cedar order is late\n</user_notes>';

/** A REAL assembled prompt, measured — the affect state is passed so the internal-weather block
 *  actually renders, which is what the leak guard needs something to find. */
function realPrompt() {
  const chatContext: ChatContext = {
    isGroupChat: false, participantNames: [], chatName: null,
    senderHandle: PROFILE.handle, senderProfile: PROFILE,
  };
  return buildSystemPromptSections(
    chatContext, CONTEXT_BLOCK, [], undefined, undefined, HISTORY, 'any news on the cedars?',
    'UTC', affect(), COMPUTED, null, undefined, undefined, null,
    { text: 'any news on the cedars?', hits: [{ label: 'the cedar order', source: 'thread' }] },
  );
}

/** The turn inputs convo/client.ts hands processConvoResult, over that real prompt. */
function turnInputs(): TurnTraceTurnInputs {
  return {
    prompt: realPrompt(),
    messages: [
      { content: 'any word on the cedars' },
      { content: 'checking now' },
      { content: 'any news on the cedars?' },
    ],
    gates: {
      threads: null,
      memory: { shortHotLook: 'full' },
      extras: { updateNote: false, introWeave: false, activeOps: 0 },
    },
    hits: ['the cedar order'],
  };
}

const SPOKE: TurnTraceOutcome = { wasEnvelope: true, retried: false, silent: false, toolCalls: [] };
const SAID_NOTHING: TurnTraceOutcome = { wasEnvelope: false, retried: true, silent: true, toolCalls: [] };

function draft(outcome: TurnTraceOutcome = SPOKE, raw: Record<string, unknown> | null = GOOD_STATUS): TurnTraceDraft {
  return buildTurnTraceDraft({
    turn: turnInputs(),
    affect: { raw, coerced: coerceStatus(raw) },
    outcome,
  });
}

const NO_BUBBLES = buildBubbleReport([], { hardCapped: false, splits: 0 });
const TWO_BUBBLES = buildBubbleReport(['on it', 'the cedars are still in transit'], { hardCapped: false, splits: 0 });

// ── the coercion diff ────────────────────────────────────────────────────────

test('a status the persona would recognize records no coercions at all', () => {
  assert.deepEqual(describeStatusCoercions(GOOD_STATUS, coerceStatus(GOOD_STATUS)), []);
});

test('the coercion diff names the field, what the model wrote, and what it became', () => {
  const raw = { ...GOOD_STATUS, mood_level: 'very high' };
  assert.deepEqual(describeStatusCoercions(raw, coerceStatus(raw)), [
    { field: 'mood_level', from: 'very high', to: 50, reason: 'not_a_number' },
  ]);

  // The two threading fields are the only ones the coercer can REFUSE outright (a wrong guess there
  // would invent a fact about the person's life), so a refusal is its own reason.
  const refused = { ...GOOD_STATUS, thread_outcome: 'delighted' };
  assert.deepEqual(describeStatusCoercions(refused, coerceStatus(refused)), [
    { field: 'thread_outcome', from: 'delighted', to: null, reason: 'dropped' },
  ]);

  // An out-of-range integer is clamped, a numeric string is parsed, an unknown enum is replaced,
  // and a missing field is named as absent rather than silently defaulted.
  const messy = { ...GOOD_STATUS, patience: 900, warmth: '64', intent_mode: 'vibing' };
  delete messy.rapport;
  const coercions = describeStatusCoercions(messy, coerceStatus(messy));
  assert.deepEqual(coercions, [
    { field: 'warmth', from: '64', to: 64, reason: 'parsed' },
    { field: 'rapport', from: null, to: 50, reason: 'absent' },
    { field: 'patience', from: 900, to: 100, reason: 'clamped' },
    { field: 'intent_mode', from: 'vibing', to: 'questioning', reason: 'replaced' },
  ]);
  // Every reason comes from the closed vocabulary, so a scan of the ring can bucket them.
  for (const c of coercions) assert.ok(STATUS_COERCION_REASONS.includes(c.reason), c.reason);
});

test('a garbled envelope files a receipt naming the whole-object default', () => {
  const detail = buildTurnTrace({ draft: draft(SAID_NOTHING, null), bubbles: NO_BUBBLES });

  assert.equal(detail.affect.source, 'defaulted');
  assert.equal(detail.affect.rawEmitted, null);
  assert.equal(detail.affect.coerced, null);
  assert.deepEqual(detail.affect.coercions, [
    { field: 'status', from: null, to: null, reason: 'absent' },
  ]);
  // And the rest of the receipt is intact — a turn with no usable envelope is exactly the turn
  // worth attributing, so it still says what the prompt was made of.
  assert.equal(detail.outcome.wasEnvelope, false);
  assert.equal(detail.outcome.retried, true);
  assert.equal(detail.bubbles.count, 0);
  assert.ok(detail.prompt.systemChars > 1000, 'the prompt it measured is the real one');
});

test('an emitted status rides along coerced, with its raw copy', () => {
  const detail = buildTurnTrace({ draft: draft(), bubbles: TWO_BUBBLES });
  assert.equal(detail.affect.source, 'emitted');
  assert.equal(detail.affect.coerced?.mood_label, 'hopeful');
  assert.equal((detail.affect.rawEmitted as Record<string, unknown>).mood_level, 72);
  assert.deepEqual(detail.affect.coercions, []);
});

// ── the prompt measurement ───────────────────────────────────────────────────

test('the measured sections add back up to the prompt they came from', () => {
  const prompt = realPrompt();
  const detail = buildTurnTrace({ draft: draft(), bubbles: TWO_BUBBLES });

  assert.equal(detail.prompt.systemChars, prompt.system.length);
  // The exhaustiveness check, in Task 1's own arithmetic — every character of the assembled prompt
  // is accounted for by a named section plus the separators between them.
  assert.equal(sectionsTotalChars(detail.prompt.sections), detail.prompt.systemChars);

  const dyn = prompt.sections.filter(s => isDynSection(s.name)).reduce((n, s) => n + s.chars, 0);
  assert.equal(detail.prompt.dynChars, dyn, 'dynChars is the per-turn block, persona and anchors excluded');
  assert.equal(detail.prompt.personaChars, prompt.personaChars);
  assert.equal(detail.prompt.anchorChars, prompt.anchorChars);
  assert.ok(detail.prompt.personaChars > detail.prompt.dynChars, 'the persona is still the bulk of it');

  // The transcript's share of everything the model reads.
  assert.equal(detail.prompt.transcriptRows, 3);
  assert.equal(detail.prompt.messagesChars, 'any word on the cedars'.length + 'checking now'.length + 'any news on the cedars?'.length);
  const share = detail.prompt.messagesChars / (detail.prompt.systemChars + detail.prompt.messagesChars);
  assert.equal(detail.prompt.transcriptShare, Math.round(share * 10_000) / 10_000);
});

test('the section list is capped, and the cap sits above the whole section vocabulary', () => {
  // The cap is a bound on a runaway list, not a real limit: a build can carry at most one entry per
  // section id, so it can never fire on an assembled prompt — which is what keeps the arithmetic
  // above exhaustive rather than approximate.
  assert.ok(SECTION_IDS.length < TRACE_SECTIONS_CAP, `${SECTION_IDS.length} sections < cap ${TRACE_SECTIONS_CAP}`);

  const many = Array.from({ length: 40 }, () => ({ name: 'extra' as const, chars: 10 }));
  const detail = buildTurnTrace({
    draft: buildTurnTraceDraft({
      turn: { ...turnInputs(), prompt: { ...realPrompt(), sections: many } },
      affect: { raw: GOOD_STATUS, coerced: coerceStatus(GOOD_STATUS) },
      outcome: SPOKE,
    }),
    bubbles: TWO_BUBBLES,
  });
  assert.equal(detail.prompt.sections.length, TRACE_SECTIONS_CAP);
  assert.equal(detail.prompt.dynChars, 400, 'the sizes are still measured off the whole list');
});

// ── the leak guard ───────────────────────────────────────────────────────────

test('the receipt carries names and numbers only — no prompt text, ever', () => {
  const detail = buildTurnTrace({ draft: draft(), bubbles: TWO_BUBBLES });
  const json = JSON.stringify(detail);

  // The internal-weather block's header (persona/status.ts) — the state that must never surface.
  assert.ok(!/INTERNAL weather/i.test(json), 'no internal-weather block');
  // The persona's own first line.
  const personaFirstLine = loadContext('convo').split('\n')[0].trim();
  assert.ok(personaFirstLine.length > 10, 'the persona fixture is real');
  assert.ok(!json.includes(personaFirstLine), 'no persona text');
  // The prompt wrapper, the user's dossier, and the JSON anchor's own words.
  assert.ok(!json.includes('<prompt>'), 'no prompt block');
  assert.ok(!json.includes('runs a nursery'), 'no dossier text');
  assert.ok(!json.includes('Last thing before you type'), 'no anchor text');
  // What it DOES carry: the section names and their sizes.
  assert.ok(json.includes('"persona"') && json.includes('"json_anchor"'), 'names are the payload');
});

// ── the boundary contract ────────────────────────────────────────────────────

test('a turn that ships nothing is silent; anything that ships is not', () => {
  const nothing = buildTurnTrace({ draft: draft(SAID_NOTHING), bubbles: NO_BUBBLES });
  assert.equal(nothing.outcome.silent, true);
  assert.equal(nothing.bubbles.count, 0);

  // The boundary has the last word: bubbles actually went out, so the turn was not silent whatever
  // the Convo turn thought it produced.
  const spoke = buildTurnTrace({ draft: draft(SAID_NOTHING), bubbles: TWO_BUBBLES });
  assert.equal(spoke.outcome.silent, false);

  // A reaction-only turn ships no bubbles and is NOT silent — the tapback is the reply.
  const reacted = buildTurnTrace({ draft: draft({ ...SPOKE, silent: false }), bubbles: NO_BUBBLES });
  assert.equal(reacted.outcome.silent, false);
  assert.equal(reacted.bubbles.count, 0);
});

test('buildTurnTrace is pure', () => {
  const d = draft();
  Object.freeze(d);
  Object.freeze(d.prompt);
  Object.freeze(d.prompt.sections);
  Object.freeze(d.hits);
  Object.freeze(d.outcome);
  Object.freeze(d.gates);
  Object.freeze(d.affect);
  const first = buildTurnTrace({ draft: d, bubbles: TWO_BUBBLES });
  const second = buildTurnTrace({ draft: d, bubbles: TWO_BUBBLES });
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'a fresh detail each call');
  assert.notEqual(first.hits, d.hits, 'and it copies rather than hands out the draft\'s own arrays');
  assert.deepEqual(d.hits, ['the cedar order'], 'the draft is untouched');

  // Every container the builder OWNS is fresh, not the draft's own object — so nothing that mutated
  // a draft after the fact could reach a detail already built from it. The three payloads it does
  // pass through by reference (the thread report, and the model's raw/coerced status) are documented
  // as such on the function, and `record` deep-copies the whole detail on the way into the ring.
  assert.notEqual(first.prompt, d.prompt, 'prompt');
  assert.notEqual(first.prompt.sections, d.prompt.sections, 'prompt.sections');
  assert.notEqual(first.outcome, d.outcome, 'outcome');
  assert.notEqual(first.gates, d.gates, 'gates');
  assert.notEqual(first.gates.memory, d.gates.memory, 'gates.memory');
  assert.notEqual(first.gates.extras, d.gates.extras, 'gates.extras');
  assert.notEqual(first.affect, d.affect, 'affect');
  assert.notEqual(first.affect.coercions, d.affect.coercions, 'affect.coercions');
});

// ── the flag ─────────────────────────────────────────────────────────────────

test('the flag off files no event; on, exactly one turn:trace', () => {
  const chatId = randomUUID();
  clearTraces();
  process.env.TURN_TRACE_ENABLED = 'false';
  try {
    recordTurnTrace(draft(), { chatId, handle: PROFILE.handle, bubbles: TWO_BUBBLES });
    assert.equal(getTraces().length, 0, 'nothing recorded with the flag off');
  } finally {
    delete process.env.TURN_TRACE_ENABLED;
  }

  recordTurnTrace(draft(), { chatId, handle: PROFILE.handle, bubbles: TWO_BUBBLES });
  const events = getTraces();
  assert.equal(events.length, 1);
  assert.equal(events[0].label, TURN_TRACE_LABEL);
  assert.equal(events[0].chatId, chatId);
  assert.equal(events[0].handle, PROFILE.handle);
  const detail = events[0].detail as { bubbles: { count: number }; prompt: { transcriptRows: number } };
  assert.equal(detail.bubbles.count, 2);
  assert.equal(detail.prompt.transcriptRows, 3);

  // A missing draft is not an event either: the command fast paths (/help, /clear) never build a
  // prompt, so there is nothing to attribute.
  recordTurnTrace(undefined, { chatId, handle: PROFILE.handle, bubbles: TWO_BUBBLES });
  assert.equal(getTraces().length, 1);
  clearTraces();
});

// ── the seam: a real Convo turn returns the draft the boundary needs ─────────

const ASK = 'haha ok tell me a joke about cats';

function envelope(bubbles: string[], status?: Record<string, unknown>, toolCalls: LlmToolCall[] = []): LlmResult {
  const body = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
    ...(status ? { status } : {}),
  };
  return { text: JSON.stringify(body), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function convoArgs() {
  __resetOpsCoordination();
  const sender = `+1555710${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return {
    chatId: randomUUID(),
    handle: sender,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend: ASK,
    trace: turnInputs(),
  };
}

test('a Convo turn hands the send boundary a draft of everything but the bubbles', async () => {
  const out = await processConvoResult({ ...convoArgs(), res: envelope(['ha', 'ok one cat joke'], GOOD_STATUS) });

  const d = out.turnTrace!;
  assert.ok(d, 'the draft rides the ChatResponse');
  assert.equal(d.affect.source, 'emitted');
  assert.equal(d.affect.coerced?.mood_core, 'joyful');
  assert.deepEqual(d.outcome, { wasEnvelope: true, retried: false, silent: false, toolCalls: [] });
  assert.deepEqual(d.hits, ['the cedar order'], 'the turn-focus hits ride through');
  assert.equal(d.gates.memory.shortHotLook, 'full');
  assert.equal(d.prompt.systemChars, realPrompt().system.length);

  // The bubbles are the one thing it does NOT have — the boundary owns that.
  assert.equal('bubbles' in d, false);
});

test('a reply with no usable envelope still hands over a draft', async () => {
  const res: LlmResult = { text: 'ha, cats', toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
  const out = await processConvoResult({ ...convoArgs(), res });

  const d = out.turnTrace!;
  assert.equal(d.outcome.wasEnvelope, false);
  assert.equal(d.affect.source, 'defaulted');
  assert.deepEqual(d.affect.coercions, [{ field: 'status', from: null, to: null, reason: 'absent' }]);
});

test('a silent-turn retry that was spent and died still reads as retried', async () => {
  // The floor spends its ONE extra call, the call throws, and Fallfirm voices the floor instead —
  // all on this same pass, so `args.silentRetry` is still false when the draft is built. The receipt
  // must not read like a turn that never tried: `convo:silent_turn` already recorded
  // `recovery: 'retry'`, and a receipt that disagrees with it is worse than no receipt.
  const out = await processConvoResult({
    ...convoArgs(),
    res: envelope([], GOOD_STATUS),   // schema-valid and empty: the live silent-turn shape
    turn: {
      system: 'SYSTEM PROMPT (persona + this turn)',
      messages: [{ role: 'user', content: ASK }],
      tools: [],
      call: async () => { throw new Error('provider down'); },
    },
  });
  assert.equal(out.turnTrace!.outcome.retried, true, 'a spent retry is in the receipt even when it died');
  assert.ok(out.text && out.text.trim().length, 'and the user is still not left on read');
});

test('the tool-only turn the receipt calls silent is the same turn the tripwire flags', async () => {
  clearTraces();
  const base = convoArgs();
  // A `remember_user` the cross-user guard REFUSES (the handle is neither the sender nor a
  // participant) with no bubbles: a tool-BEARING turn that put nothing on their screen and did
  // nothing on their behalf. The silent-turn floor cannot recover it — `!res.toolCalls.length` is
  // its whole guard — so this is exactly the variant the `convo:silent_turn` tripwire still exists
  // to surface, and the receipt claims parity with that tripwire. ONE predicate, both readers: this
  // is what would break if a future visible-action channel were added to only one of them.
  const out = await processConvoResult({
    ...base,
    res: envelope([], GOOD_STATUS, [{ name: 'remember_user', input: { handle: '+15559998888', fact: 'likes cedars' } }]),
  });

  const d = out.turnTrace!;
  assert.deepEqual(d.outcome.toolCalls, ['remember_user'], 'names only, and the tool did run');
  const flagged = getTraces().some(e => e.label === 'convo:silent_turn' && e.chatId === base.chatId);
  assert.equal(d.outcome.silent, flagged, 'the receipt and the tripwire read the SAME predicate');
  assert.equal(d.outcome.silent, true, 'and on this turn both of them say silent');
  clearTraces();
});

test('the flag off returns no draft, so the boundary has nothing to file', async () => {
  process.env.TURN_TRACE_ENABLED = 'off';
  try {
    const out = await processConvoResult({ ...convoArgs(), res: envelope(['ha'], GOOD_STATUS) });
    assert.equal(out.turnTrace, undefined);
    assert.equal(out.text, 'ha', 'and the reply itself is untouched');
  } finally {
    delete process.env.TURN_TRACE_ENABLED;
  }
});
