// The rhythm engine, WIRED. persona/hooks.test.ts owns the arithmetic and the rendered bytes; this
// file owns everything that happens around them on a real turn: which section the directive puts in
// the prompt and where, what the two flags cost when they are off, the one corrective re-ask a
// broken quiet turn gets, and the ledger row the turn leaves behind.
//
// Four seams, four shapes of test. The assembler is pure, so those cases are argument tuples. The
// quiet guard calls the model, so those go through the injected `turn.call` seam the promise guard's
// suite uses. The ledger is a store write, so those run end to end against the ephemeral backend —
// including in a GROUP, which is the one place this engine deliberately does not fence itself off.
// And the pre-read that decides everything the first three are handed lives in convo/client.ts, so
// the last block drives `chat` itself through its own injected lane (the forgetEngine precedent).

process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// The recall second pass is driven for real in the quiet-guard block below, and query expansion
// defaults ON in production and dispatches a REAL classify call when nothing is injected. Pinned off
// for the file, the recallMemory.test.ts way, so nothing here can reach a provider.
process.env.MEMORY_RECALL_EXPANSION = 'off';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildSystemPromptSections, enforceQuiet, processConvoResult, QUIET_CORRECTION,
  quietStoodDownReceipt,
  type ChatContext, type ConvoTurnContext, type PersonaTurn,
} from './shared.js';
import { chat } from './client.js';
import { clearIdleClassifyCache } from './idleClassify.js';
import { craftModuleText } from './personaModules.js';
import { DYN_SECTION_IDS, type SectionId } from './promptSections.js';
import { REACTION_TOOL, DELEGATE_TO_OPS_TOOL } from './tools.js';
import {
  HOOK_HEADING, HOOK_NONE_OPEN, HOOK_LATE_LINE, HOOK_WORDS, MOMENTS_LEAD, QUIET_LAW, renderHooksSection,
  type HookDirective, type HookSelectReport, type HookState,
} from '../../persona/hooks.js';
import { getHookState } from '../../db/repositories/hookState.js';
import { saveRelationshipClimate } from '../../db/repositories/relationshipClimate.js';
import { defaultClimate } from '../../persona/climate.js';
import { groupHandle } from '../../memory/identity.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// A frozen clock, the same pin promptBudget.test.ts installs and for the same reason: the assembler
// reads the wall clock for its time and timing sections, so "the same turn twice is the same bytes"
// is only true while the clock is held still. Pinned by hand rather than with node:test's
// MockTimers, which prints an ExperimentalWarning.
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// NO LANE, deliberately. Every model call in this file is either injected at the seam or must FAIL,
// and the idle classifier is the one that would otherwise reach a network from a unit test: a short
// message the English fast path cannot read goes to layer 3, and layer 3 is a real `callLLM`
// (convo/idleClassify.ts). Blank keys read as unconfigured everywhere (llm/laneKeys.ts), so the call
// throws instantly and the gate reads `unclear` → a task turn, which is the failing-toward-task
// behaviour the whole design rests on. The runner gives each test file its own process, so this is
// file-local.
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  // Process-local and keyed on the text alone, so one case's verdict would otherwise be the next
  // case's cache hit — and `cached: true` is a thing these tests assert about.
  clearIdleClassifyCache();
  delete process.env.CONVO_HOOKS_ENABLED;
  delete process.env.MEMORY_THESIS_ENABLED;
  delete process.env.MEMORY_MOMENTS_ENABLED;
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
});

// ── the three modes through the assembler ────────────────────────────────────

const PROFILE: UserProfile = {
  handle: '+15550001111', name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2,
};
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: '+15550001111', at: Date.UTC(2026, 0, 6, 1, 40) },
  { role: 'assistant', content: 'six to eight weeks from the north supplier', at: Date.UTC(2026, 0, 6, 1, 42) },
];
const CONTEXT_BLOCK = '## Who you are talking to\nSam, three months in.';
const EXTRA = '## One more thing\nAn addendum the caller tacked on.';
const THESIS = '## Your read on them (INTERNAL)\nThey decide fast on money and slowly on people.';
/** A moment sample as `renderMomentLines` hands it over — two lines, in the store's own shape. Only
 *  the flag test needs them: what a real sample costs the `hooks` ceiling is measured next door in
 *  promptBudget.test.ts, and what the sampler does to the ledger is pinned in earnedMaterial.test.ts. */
const MOMENT_LINES = [
  '- (habit, last week) checked the volcano dashboard again and decided nothing',
  '- (embarrassing, a month or two ago) re-did the side gate rather than call the joiner back',
];

const HOOK: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: false, offerAllowed: true,
};
const QUIET: HookDirective = { ...HOOK, mode: 'quiet', offerAllowed: false };
const TASK: HookDirective = { ...HOOK, idle: false, mode: 'task', offerAllowed: false };

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** One assembled turn, varying only the per-turn persona struct. Everything else is the same shape
 *  every case, so a difference in the output is a difference the directive caused. */
function build(personaTurn?: PersonaTurn): BuildArgs {
  return [
    { isGroupChat: false, participantNames: [], chatName: null, senderHandle: PROFILE.handle, senderProfile: PROFILE },
    CONTEXT_BLOCK, [], EXTRA, undefined, HISTORY, 'hmm', 'UTC',
    undefined, undefined, null, undefined, undefined, undefined,
    { text: 'hmm', hits: [] }, undefined, personaTurn,
  ];
}

const sectionsOf = (personaTurn?: PersonaTurn): SectionId[] =>
  buildSystemPromptSections(...build(personaTurn)).sections.map(s => s.name);

test('a TASK turn renders no hooks section — and not one byte differs from a turn with no directive', () => {
  const task = buildSystemPromptSections(...build({ hooks: TASK, moments: [], thesis: '' }));
  const none = buildSystemPromptSections(...build());
  assert.ok(!task.sections.some(s => s.name === 'hooks'));
  // The no-regression pin the whole feature rests on: on the turns that are actually work, the
  // prompt is what an install that never had a hook engine would have built.
  assert.equal(task.system, none.system);
});

test('a QUIET turn renders the quiet block, and a HOOK turn the open-kinds one', () => {
  const quiet = buildSystemPromptSections(...build({ hooks: QUIET, moments: [], thesis: '' }));
  assert.ok(quiet.system.includes(renderHooksSection(QUIET)));
  assert.ok(quiet.system.includes(QUIET_LAW));
  // A quiet block never names a kind: the mode has already spent the beat, and naming one would be
  // an instruction to think about it.
  for (const w of HOOK_WORDS) assert.ok(!renderHooksSection(QUIET).includes(w), w);

  const hook = buildSystemPromptSections(...build({ hooks: HOOK, moments: [], thesis: '' }));
  assert.ok(hook.system.includes('Open to you this turn: a judgment, a callback or a tangent.'));

  // …and only the ALLOWED kinds reach the prompt.
  const narrowed: HookDirective = { ...HOOK, forbidden: ['judgment', 'tangent'] };
  const one = buildSystemPromptSections(...build({ hooks: narrowed, moments: [], thesis: '' }));
  assert.ok(one.system.includes('Open to you this turn: a callback.'));
});

test('the two new sections land where the vocabulary says they do', () => {
  // The ids first, because the assembler asserts nothing about order — promptSections.ts does, and
  // the push sites have to agree with it.
  const ids = [...DYN_SECTION_IDS] as string[];
  assert.equal(ids[ids.indexOf('context_block') + 1], 'thesis', 'her read follows the dossier it concludes');
  assert.equal(ids[ids.indexOf('extra') + 1], 'hooks');
  assert.equal(ids[ids.indexOf('hooks') + 1], 'turn_focus', 'and turn_focus is still last');

  const rendered = sectionsOf({ hooks: HOOK, moments: [], thesis: THESIS });
  assert.deepEqual(rendered.slice(rendered.indexOf('context_block'), rendered.indexOf('context_block') + 2),
    ['context_block', 'thesis']);
  assert.deepEqual(rendered.slice(-5), ['extra', 'hooks', 'turn_focus', 'behavior_anchor', 'json_anchor']);
});

test('the drift anchor takes its mode from the same directive the section does', () => {
  // Two readings of one decision. They are rendered a hundred and fifty thousand characters apart,
  // and a turn whose edge says "answer it flat" while its section says "carry a hook" would be the
  // one contradiction this whole arrangement exists to prevent.
  const quiet = buildSystemPromptSections(...build({ hooks: QUIET, moments: [], thesis: '' }));
  const task = buildSystemPromptSections(...build({ hooks: TASK, moments: [], thesis: '' }));
  const anchorOf = (s: string) => s.slice(s.lastIndexOf('## Still the same Irises, this far down'));
  assert.notEqual(anchorOf(quiet.system), anchorOf(task.system));
});

test('an empty thesis is never pushed, so Wave 3 costs today nothing', () => {
  assert.ok(!sectionsOf({ hooks: HOOK, moments: [], thesis: '' }).includes('thesis'));
  assert.ok(!sectionsOf({ hooks: HOOK, moments: [], thesis: '   \n ' }).includes('thesis'));
});

test('each flag OFF is byte-identical to an install that never had the feature', () => {
  // All THREE features loaded at once, which is what makes the all-off assertion below mean
  // anything: a struct carrying a hook directive, a non-empty moment sample and a thesis. The
  // directive opens the moment lead (`moments: true`) — without that the sample is dropped by the
  // renderer's own gate and the moments flag would be tested against bytes that were never going to
  // render either way.
  const full: PersonaTurn = {
    hooks: { ...HOOK, moments: true }, moments: MOMENT_LINES, thesis: THESIS,
  };
  const bare = buildSystemPromptSections(...build()).system;

  process.env.CONVO_HOOKS_ENABLED = 'off';
  process.env.MEMORY_THESIS_ENABLED = 'off';
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  try {
    assert.equal(buildSystemPromptSections(...build(full)).system, bare, 'all off: nothing is added');
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
    delete process.env.MEMORY_THESIS_ENABLED;
    delete process.env.MEMORY_MOMENTS_ENABLED;
  }
  // …and the comparison has teeth: with the flags at their defaults the same struct changes the
  // prompt in all three places.
  const on = buildSystemPromptSections(...build(full)).system;
  assert.notEqual(on, bare);
  assert.ok(on.includes(THESIS));
  for (const line of MOMENT_LINES) assert.ok(on.includes(line));

  // Each flag is read at CALL time and gates only its own section.
  process.env.CONVO_HOOKS_ENABLED = 'off';
  try {
    const hooksOff = buildSystemPromptSections(...build(full)).system;
    assert.ok(hooksOff.includes(THESIS), 'the thesis is not the hook flag\'s business');
    assert.ok(!hooksOff.includes(QUIET_LAW));
    for (const line of MOMENT_LINES) {
      assert.ok(!hooksOff.includes(line), 'the moments ride INSIDE the hooks section, so they go with it');
    }
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }

  // The moments flag is gated at the PUSH SITE like its two siblings, so a caller holding a stale
  // sample — the flag flipped between the read and the build, or any future caller that fills the
  // struct without re-reading it — cannot put moment lines into a MEASURED section on an install
  // that turned them off. The hooks section itself still renders: it is not the moments' business
  // either.
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  try {
    const momentsOff = buildSystemPromptSections(...build(full)).system;
    assert.ok(momentsOff.includes(HOOK_HEADING), 'the hook turn is not the moments flag\'s business');
    assert.ok(momentsOff.includes(THESIS));
    assert.ok(!momentsOff.includes(MOMENTS_LEAD), 'no lead, because there is nothing to lead with');
    for (const line of MOMENT_LINES) assert.ok(!momentsOff.includes(line));
  } finally {
    delete process.env.MEMORY_MOMENTS_ENABLED;
  }
});

// ── the quiet guard ──────────────────────────────────────────────────────────

const SENDER = '+15550001111';

/** One reply as the lane really hands it back under `toolsViaJson`: the calls appear BOTH inside the
 *  envelope text (where the model wrote them) and on `LlmResult.toolCalls` (where callLLM parses them
 *  back to), because every guard in shared.ts reads the parsed field. A tapback is therefore an
 *  envelope with no bubbles AND a send_reaction call — not an empty envelope. */
function envelope(bubbles: string[], hookKind?: string, toolCalls: LlmToolCall[] = []): LlmResult {
  const status: Record<string, unknown> = {
    mood_label: 'content', mood_shift: 'steady', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'let it be quiet',
  };
  if (hookKind) status.hook_kind = hookKind;
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: toolCalls.length ? toolCalls.map(t => ({ name: t.name, args: t.input })) : null,
      bubbles: bubbles.map(text => ({ text, re: null })),
      status,
    }),
    toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test',
  };
}

/** The reaction call a tapback turn carries. */
const TAPBACK: LlmToolCall[] = [{ name: 'send_reaction', input: { type: 'like' } }];

function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: 'hmm' }],
    tools: [REACTION_TOOL, DELEGATE_TO_OPS_TOOL],
    call,
  };
}

function guardArgs(res: LlmResult) {
  return { res, chatId: randomUUID(), handle: SENDER, turn: undefined as ConvoTurnContext | undefined };
}

function quietReceipt() {
  return getTraces().find(e => e.type === 'event' && e.label === 'convo:quiet_guard')?.detail as
    Record<string, unknown> | undefined;
}

/** EVERY quiet-guard row this turn filed, not just the first — the one-per-visible-turn rule is a
 *  claim about the count, and `quietReceipt` above cannot see a second one. */
function quietGuardReceipts() {
  return getTraces().filter(e => e.type === 'event' && e.label === 'convo:quiet_guard');
}

const LOUD = ['three sharp things in a row already', 'and here is a fourth one for good measure'];

test('a quiet turn she got RIGHT files the healthy no-op and never calls', async () => {
  let calls = 0;
  const res = envelope(['mm']);
  const out = await enforceQuiet({ ...guardArgs(res), turn: turnCtx(async () => { calls++; return res; }) }, ['mm'], undefined);
  assert.equal(calls, 0);
  assert.equal(out.fired, false);
  assert.equal(out.res, res, 'the reply is untouched');
  // The no-op IS the receipt: a battery has to be able to tell a forced-quiet turn she got right
  // from a forced-quiet turn that never happened.
  assert.deepEqual(quietReceipt(), { forced: true, emitted: null, bubbles: 1, retried: false, resolved: 'clean' });
});

test('a loud reply gets ONE re-ask carrying its own text and the correction, and a quiet retry wins', async () => {
  const seen: LlmRequest[] = [];
  const original = envelope(LOUD, 'judgment');
  const fixed = envelope(['fair enough']);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async req => { seen.push(req); return fixed; }) },
    LOUD, 'judgment',
  );
  assert.equal(seen.length, 1, 'exactly one re-ask');
  assert.deepEqual(seen[0].messages.slice(-2), [
    { role: 'assistant', content: original.text },
    { role: 'user', content: QUIET_CORRECTION },
  ]);
  assert.equal(seen[0].trace?.label, 'convo:quiet_retry', 'the CALL and the decision are separate labels');
  assert.equal(out.res, fixed);
  assert.deepEqual(quietReceipt(), { forced: true, emitted: 'judgment', bubbles: 2, retried: true, resolved: 'quiet' });
});

test('the correction states the law she was already given, and asks for a null hook_kind', () => {
  // The re-ask restates rather than introduces: the same sentence her prompt carried this turn.
  assert.ok(QUIET_CORRECTION.startsWith(QUIET_LAW));
  assert.match(QUIET_CORRECTION, /hook_kind/);
  assert.match(QUIET_CORRECTION, /one short bubble|tapback/);
});

test('a retry that is still loud keeps the ORIGINAL — never a dropped turn, never edited text', async () => {
  const original = envelope(LOUD);
  const stillLoud = envelope(['still going', 'and going']);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async () => stillLoud) },
    LOUD, undefined,
  );
  assert.equal(out.res, original, 'a bad retry is worse than a long bubble');
  assert.equal(out.fired, true);
  assert.equal(quietReceipt()?.resolved, 'kept_original');
});

test('a tapback retry — a reaction and no words — is a legal quiet reply and is accepted', async () => {
  const original = envelope(LOUD);
  const tapback = envelope([], undefined, TAPBACK);
  const out = await enforceQuiet({ ...guardArgs(original), turn: turnCtx(async () => tapback) }, LOUD, undefined);
  assert.equal(out.res, tapback);
  assert.equal(quietReceipt()?.resolved, 'quiet');
});

test('an EMPTY retry with no tool call keeps the ORIGINAL — a bubble-less reply needs a tapback behind it', async () => {
  // The small-into-large swap this guard exists to refuse. An accepted empty envelope reaches the
  // silent-turn block downstream, spends the silent retry, and lands on the Fallfirm floor: a machine
  // line traded for a reply that was one bubble too long.
  const original = envelope(LOUD);
  const nothing = envelope([]);
  const out = await enforceQuiet({ ...guardArgs(original), turn: turnCtx(async () => nothing) }, LOUD, undefined);
  assert.equal(out.res, original, 'empty bubbles are legal only next to a send_reaction');
  assert.equal(quietReceipt()?.resolved, 'kept_original');
});

test('a thrown re-ask ships the original and is reported as a spent recovery', async () => {
  const original = envelope(LOUD);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async () => { throw new Error('lane down'); }) },
    LOUD, undefined,
  );
  assert.equal(out.res, original);
  assert.deepEqual(quietReceipt(), { forced: true, emitted: null, bubbles: 2, retried: true, resolved: 'kept_original' });
});

// ── one re-ask per turn, and the ledger, through the real turn ───────────────

function turnArgs(over: Partial<Parameters<typeof processConvoResult>[0]> = {}) {
  const chatContext: ChatContext = {
    isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER,
  };
  return {
    chatId: randomUUID(),
    handle: SENDER,
    chatContext,
    history: [] as StoredMessage[],
    media: emptyMedia(),
    textToSend: 'hmm',
    ...over,
  };
}

function hookArgs(directive: HookDirective, state?: Partial<HookState>) {
  const report: HookSelectReport = {
    reason: directive.mode === 'quiet' ? 'kill_switch' : directive.idle ? 'hook' : 'not_idle',
    idleLayer: directive.idle ? 'fast_path' : 'veto',
    forbidden: directive.forbidden,
    lastKinds: state?.lastKinds ?? [],
  };
  return {
    directive,
    report,
    state: { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0, ...state },
    forgetEpoch: 0,
    // The sampler's own answer for the turn (convo/client.ts). False everywhere in this file: what a
    // moment offer does to the ledger is pinned next door, in convo/earnedMaterial.test.ts.
    momentOffered: false,
  };
}

test('the promise guard goes first, and its firing stands the quiet re-ask down', async () => {
  // Honesty outranks rhythm, and a reply asked twice has stopped being hers. The draft below is BOTH
  // failures at once: it promises work with no tool call and nothing running, on a forced-quiet turn.
  const calls: string[] = [];
  await processConvoResult({
    ...turnArgs(),
    res: envelope(['on it', 'checking that now']),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => {
      calls.push(String(req.trace?.label));
      return envelope(['nothing running on my end']);
    }),
  });
  assert.deepEqual(calls, ['convo:unkept_retry'], 'ONE extra call on the turn, and it is the honesty one');
  // …and the receipt is filed anyway, saying so. This is the half that keeps the kill switch
  // scorable: the guard files on every forced turn it EVALUATES precisely so a battery can tell a
  // quiet turn she got right from a forced turn that never happened, and a turn where the guard
  // never ran reads as "never happened" from the ring. Without this row, three hooks followed by a
  // promise-breaking draft would look exactly like a switch that had stopped firing.
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: null, bubbles: 2, retried: false, resolved: 'stood_down',
  });
});

// The row itself, at its own seam. PURE — it returns the receipt rather than filing it, because the
// pass that builds it may be a pass that discards its draft, and a receipt about text nobody reads
// is worse than no receipt at all.
test('the stood-down row reports a turn that was forced and never re-asked', () => {
  assert.deepEqual(quietStoodDownReceipt(['on it', 'checking that now'], undefined), {
    forced: true, emitted: null, bubbles: 2, retried: false, resolved: 'stood_down',
  });
  // A kind she emitted is still reported: the guard did not evaluate the turn, and what she wrote
  // shipped unchecked — which is exactly the case a battery must not read as a clean pass.
  assert.deepEqual(quietStoodDownReceipt(['fair enough'], 'judgment'), {
    forced: true, emitted: 'judgment', bubbles: 1, retried: false, resolved: 'stood_down',
  });
  // A tapback turn: no bubbles at all, and the row still exists, because "forced quiet" and "a row
  // in the ring" have to mean the same thing whichever way the turn went.
  assert.deepEqual(quietStoodDownReceipt([], undefined).bubbles, 0);
});

// ONE re-ask and ONE row per USER-VISIBLE turn — and the pass that owns both is the one that SHIPS.
// The recall second pass re-enters processConvoResult with the archive snippets appended, makes its
// own model call, discards the first pass's draft and returns from there, so fencing the guard off
// `archivePass` takes it off the only reply the user reads: the ring would carry a clean row about a
// draft nobody saw, and the battery would score a PASS off text that never went out.
test('a spent re-ask does not stop the shipping pass being read — it evaluates and cannot call again', async () => {
  const calls: string[] = [];
  const args = {
    ...turnArgs(),
    res: envelope(LOUD, 'tangent'),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => { calls.push(String(req.trace?.label)); return envelope(['mm']); }),
  };
  await processConvoResult(args);
  assert.deepEqual(calls, ['convo:quiet_retry'], 'a first pass with nothing spent yet gets the one call');
  assert.equal(quietGuardReceipts().length, 1);
  assert.equal(quietReceipt()?.resolved, 'quiet');

  // The same loud draft on a pass that inherits a spent re-ask: read, reported, never re-asked. The
  // resolution is the guard's own worst case, honestly — that text is what would ship.
  clearTraces();
  calls.length = 0;
  await processConvoResult({ ...args, archivePass: true, quietSpent: true });
  assert.deepEqual(calls, [], 'the turn\'s one corrective call is gone');
  assert.equal(quietGuardReceipts().length, 1, 'still one row for one thing the user sees once');
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: 'tangent', bubbles: 2, retried: false, resolved: 'kept_original',
  });
});

// The other half of the same rule: a pass that RECURSES leaves no row behind, so the turn's one row
// is the shipping pass's. Driven through the real recall path — the first pass calls recall_memory,
// the second answers from the archive — because that is the only way the recursion happens for real.
test('a forced-quiet turn that recalls files exactly one row, and it reads the reply that ships', async () => {
  const calls: string[] = [];
  let n = 0;
  const args = {
    ...turnArgs(),
    // A CLEAN first draft that asks the archive: the row it would have filed says 'clean', and the
    // reply the user actually gets is the loud one below. The old fence filed the first and shipped
    // the second unchecked.
    res: envelope(['mm'], undefined, [{ name: 'recall_memory', input: { query: 'the cedars' } }]),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => {
      calls.push(String(req.trace?.label));
      n += 1;
      return n === 1 ? envelope(LOUD, 'tangent') : envelope(['mm']);
    }),
  };
  await processConvoResult(args);
  assert.deepEqual(calls, ['convo:archive_recall', 'convo:quiet_retry'],
    'the second pass made the reply, and the guard on it spent the turn\'s one call');
  const rows = quietGuardReceipts();
  assert.equal(rows.length, 1, 'one row for one user-visible turn');
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: 'tangent', bubbles: 2, retried: true, resolved: 'quiet',
  }, 'and it reads the SECOND pass\'s draft — the first pass\'s clean row went with its discarded text');
});

test('a forced-quiet turn with no promise in it does reach the quiet guard', async () => {
  await processConvoResult({
    ...turnArgs(),
    res: envelope(LOUD, 'tangent'),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async () => envelope(['mm'])),
  });
  assert.equal(quietReceipt()?.resolved, 'quiet');
});

test('a task turn that hooked anyway is counted and receipted, and is NOT re-asked', async () => {
  const calls: string[] = [];
  await processConvoResult({
    ...turnArgs(),
    res: envelope(['six to eight weeks, same as last time'], 'judgment'),
    hooks: hookArgs(TASK),
    turn: turnCtx(async req => { calls.push(String(req.trace?.label)); return envelope(['x']); }),
  });
  assert.deepEqual(calls, [], 'a second call over one envelope field is not worth a turn\'s recovery');
  assert.equal(quietReceipt(), undefined);
  const off = getTraces().find(e => e.label === 'hook:off_turn')?.detail;
  assert.deepEqual(off, { emitted: 'judgment', idle: false });
});

test('the ledger records what shipped — a violation counts as its emitted kind', async () => {
  const args = turnArgs();
  await processConvoResult({
    ...args,
    res: envelope(['a whole paragraph of a reply that is very much not one short bubble at all'], 'judgment'),
    hooks: hookArgs(QUIET),
    // No turn context, so the one recovery cannot be spent and the loud reply really ships.
  });
  const state = await getHookState(args.chatId);
  assert.deepEqual(state.lastKinds, ['judgment'], 'the run really did get another sharp beat');
  assert.equal(state.idleStreak, 1);
});

test('a task turn ends the idle streak; the ledger row is written either way', async () => {
  const args = turnArgs();
  await processConvoResult({
    ...args,
    res: envelope(['six to eight weeks']),
    hooks: hookArgs(TASK, { idleStreak: 4, lastKinds: ['callback'] }),
  });
  const state = await getHookState(args.chatId);
  assert.deepEqual(state.lastKinds, ['callback', 'none']);
  assert.equal(state.idleStreak, 0, 'one real ask is them sending something');
});

test('a ROOM accumulates a ledger too — three hooked replies make the fourth turn quiet', async () => {
  // The one write in processConvoResult that is deliberately OUTSIDE the non-group guard. Every
  // other per-person write down there is fenced off a room because it records a property of a
  // PERSON; this one records how fast SHE has been talking, and three sharp replies in a room are
  // three sharp replies whoever typed at her.
  const chatId = randomUUID();
  const handle = groupHandle(chatId);
  const chatContext: ChatContext = {
    isGroupChat: true, participantNames: ['Sam', 'Ada'], chatName: 'nursery crew', senderHandle: SENDER,
  };
  for (const kind of ['judgment', 'callback', 'tangent'] as const) {
    const state = await getHookState(chatId);
    await processConvoResult({
      ...turnArgs({ chatId, handle, chatContext }),
      res: envelope(['mm'], kind),
      hooks: { ...hookArgs(HOOK), state },
    });
  }
  const state = await getHookState(chatId);
  assert.deepEqual(state.lastKinds, ['judgment', 'callback', 'tangent']);
  assert.equal(state.idleStreak, 3);
});

test('with the flag off nothing is written and no receipt is filed', async () => {
  process.env.CONVO_HOOKS_ENABLED = 'off';
  try {
    const args = turnArgs();
    // The caller passes no directive at all when the flag is off (convo/client.ts), which is what is
    // reproduced here: nothing to record against, so nothing is recorded.
    await processConvoResult({ ...args, res: envelope(['mm'], 'judgment'), hooks: null });
    assert.deepEqual(await getHookState(args.chatId), { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });
    assert.equal(quietReceipt(), undefined);
    assert.equal(getTraces().find(e => e.label === 'hook:off_turn'), undefined);
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }
});

// ── the client seam: the pre-read on a REAL turn ─────────────────────────────
// Everything above drives the assembler and processConvoResult directly, which cannot see the block
// that decides what to hand them. These cases go through the front door (convo/client.ts `chat`)
// with the model faked at the lane seam and nothing else stubbed — the forgetEngine/routingGate
// pattern — so the idle facts, the flag gate, the thread veto, the craft fact and the three
// turn-focus fields are all the turn's own.

/** A capturing fake lane: every request the client made, and one fixed reply for each. */
function fakeLane(res: LlmResult): { seen: LlmRequest[]; call: (req: LlmRequest) => Promise<LlmResult> } {
  const seen: LlmRequest[] = [];
  return { seen, call: async (req: LlmRequest) => { seen.push(req); return res; } };
}

const clientCtx = (over: Partial<ChatContext> = {}): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, ...over,
});

const receipt = (label: string) =>
  getTraces().find(e => e.type === 'event' && e.label === label)?.detail as Record<string, unknown> | undefined;

test('an IDLE message through the front door renders the hooks block, the Turn line, and leaves a ledger row', async () => {
  const chatId = randomUUID();
  // A relationship that has actually MOVED, stored before the turn so the real read picks it up
  // (db/repositories/relationshipClimate.ts, handle-keyed like the memory tiers). Without it this
  // turn renders no climate span at all, and the span is the other place this turn is described: it
  // rides every Convo turn whatever the mode, so it and the hooks section have to agree about what
  // is open. Every dial here is past its silent band — candor below its floor, which is also the
  // thing that closes one kind on this turn — so the hook-naming band lines are live rather than
  // silently absent.
  await saveRelationshipClimate(SENDER, {
    ...defaultClimate(), dials: { ease: 70, candor: 30, playfulness: 60 }, evalCount: 30,
  });
  const { seen, call } = fakeLane(envelope(['hey you']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  assert.equal(seen.length, 1, 'one front-line call');
  const system = seen[0].system ?? '';
  assert.ok(system.includes(HOOK_HEADING), 'the hooks section reached the prompt');
  // All three turn-focus fields at once, as one rendered line: the reading, the raw TYPED length, and
  // the stored streak plus this turn (the ledger row is written after the reply, so what is in hand
  // at prompt time is how many idle turns came BEFORE this one — zero, here).
  assert.ok(system.includes('Turn: idle · their message: 3 characters · 1st idle in a row'),
    `no Turn line in: ${system.slice(system.indexOf('Turn: '), system.indexOf('Turn: ') + 80)}`);

  const select = receipt('hooks:select');
  assert.equal(select?.idleLayer, 'fast_path', 'a known English stall costs no call at all');
  assert.equal(receipt('idle:classify'), undefined, '…so layer 3 was never reached');

  // THE 2AM CASE, end to end, and the reason it lands here rather than needing a fixture of its
  // own: this file's frozen clock is 02:00 UTC, which `computeCircadian` reads as `dead_night` and
  // `compileAffect` turns into `lateNight` — so every turn the front door produces on this clock is
  // a late one. (`convo/earnedMaterial.test.ts` runs the same front door on an afternoon clock.)
  //
  // The hour is a REGISTER and nothing more. It used to close every kind, shut the sampler and the
  // thread offer and take a `sleep` bucket of its own, which left one sentence — go to bed — as the
  // only content a late idle turn could carry, restated in seven prompt surfaces. Now the turn is an
  // ordinary idle turn: the kinds are open, the anchor states the HOOK law, and the one thing the
  // clock adds is the register line saying the reply is small.
  assert.equal(select?.reason, 'hook', 'the clock is not a reason for anything');
  // The one kind closed here is the CLIMATE's doing, not the hour's: this chat's candor sits below
  // its floor band, which is what `compileAffect` reads as `no_judgment`.
  assert.deepEqual(select?.forbidden, ['judgment'], 'the clock closes nothing of its own');
  assert.ok(system.includes(HOOK_LATE_LINE), 'the register line rode along');
  assert.ok(system.includes('Open to you this turn: a callback or a tangent.'),
    'under an open line naming the kinds the register left');
  assert.ok(!system.includes(HOOK_NONE_OPEN));
  // The anchor's law at the recency edge is the HOOK one, and it agrees with the section.
  assert.ok(system.includes('- This is an idle turn: one hook, of a kind the hooks section above still allows, and only one.'),
    'the drift anchor states the hook law');
  assert.ok(!system.includes('- Three sharp things in a row already, or your weather closed the beat: this reply is one plain short bubble, a tapback, or nothing.'),
    '…and not the quiet law, which is not this turn');
  // NOTHING in the assembled prompt tells her to send them to bed — the complaint that produced
  // this design was that one line arriving every night, from seven places at once.
  assert.ok(!system.includes('should sleep'), 'no prompt surface tells her what to send at this hour');
  assert.equal(quietReceipt(), undefined, 'the clock forces nothing');

  // …and the standing register, which is why this chat carries a moved climate: it renders on every
  // Convo turn whatever the mode, and four of its twelve band lines name a hook kind
  // (persona/climate.ts HOOK_NAMING). They are gated on whether a KIND IS OPEN (`hookKindOpen`),
  // never on the mode — and a late turn HAS kinds open, so they ride it here, saying the same thing
  // the section's open line says. That agreement is the pin: the register and the section are two
  // readings of one directive.
  const weather = system.slice(system.indexOf('standing register'), system.indexOf('Re-report your `status`'));
  assert.ok(weather.length > 0 && weather.includes('- No runway at all with this person.'),
    'the climate span really rendered on this turn');
  assert.ok(weather.includes('- Directness has been landing badly. No judgment this turn.'),
    'the band line that closed judgment says so, on a turn that has a beat to spend');
  assert.ok(weather.includes('- A tangent or a callback is expected of you here.'),
    '…and the register names exactly the kinds the section left open');

  // The SAME reading also gates the hook craft page (convo/personaModules.ts `idle_turn`), which is
  // the other thing the pre-read hands the assembler. Read as the page off disk rather than as a
  // literal, so the assertion survives the prose commit that replaces today's placeholder.
  assert.ok(system.includes(craftModuleText('hooks')), 'the craft page loaded off the same reading');

  // A row exists: the defaults a missing row degrades to are an empty window and a zero streak.
  const state = await getHookState(chatId);
  assert.deepEqual(state.lastKinds, ['none'], 'she carried no hook, which is still a ledger entry');
  assert.equal(state.idleStreak, 1);
});

test('a TASK message closes the thread offer, renders no hooks block, and still counts a stray hook', async () => {
  const chatId = randomUUID();
  const { seen, call } = fakeLane(envelope(['six to eight weeks, same as last time'], 'judgment'));
  await chat(chatId, 'deploy the cedars order', emptyMedia(), clientCtx(), call);

  const system = seen[0].system ?? '';
  assert.ok(!system.includes(HOOK_HEADING), 'work gets the answer, flat');
  assert.ok(system.includes('Turn: task'));

  // Layer 3 was reached and, with no lane configured, failed toward task — the whole point of the
  // asymmetry (persona/idle.ts). The receipt is what says the fallback ran at all.
  const classified = receipt('idle:classify');
  assert.equal(classified?.verdict, 'unclear');
  assert.equal(classified?.cached, false);
  assert.equal(receipt('hooks:select')?.reason, 'not_idle');

  // The rhythm engine's one veto over the thread engine: selection never ran, so nothing was billed.
  const threads = receipt('threads:select');
  assert.equal(threads?.reason, 'offer_suppressed');

  // …and the envelope field she should not have sent on a work turn is counted, not re-asked.
  assert.deepEqual(receipt('hook:off_turn'), { emitted: 'judgment', idle: false });
  assert.deepEqual((await getHookState(chatId)).lastKinds, ['judgment']);
});

test('with the hook flag OFF the whole pre-read is inert — no section, no line, no call, no receipt', async () => {
  process.env.CONVO_HOOKS_ENABLED = 'off';
  const chatId = randomUUID();
  try {
    // 'hey' is the message that DID render a hooks block one case up, so both absences below are
    // absences the flag caused rather than absences of an idle turn.
    const { seen, call } = fakeLane(envelope(['hey you']));
    await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);
    const system = seen[0].system ?? '';
    assert.ok(!system.includes(HOOK_HEADING));
    assert.ok(!system.includes('Turn: idle') && !system.includes('Turn: task'),
      'absent is a third state: no claim about the turn is made at all');
    assert.equal(receipt('hooks:select'), undefined);
    assert.deepEqual(await getHookState(chatId), { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });

    // …and a work message, which is the shape that reaches layer 3 and closes the thread offer when
    // the engine is live: no lane is spent on it, and the thread engine offers exactly as it did
    // before any of this existed.
    const work = fakeLane(envelope(['six to eight weeks, same as last time']));
    await chat(randomUUID(), 'deploy the cedars order', emptyMedia(), clientCtx(), work.call);
    assert.equal(receipt('idle:classify'), undefined, 'no gate runs, so no classify call is made');
    assert.notEqual(receipt('threads:select')?.reason, 'offer_suppressed');
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }
});

test('the gate reads what they TYPED, not the annotated message the machinery built', async () => {
  // The one deliberate deviation from the brief, pinned. The tapped-reply tag is app metadata folded
  // into `textToSend` so it persists in history, and it is long enough on its own to blow the
  // forty-character veto — which would make an idle turn impossible to have by tapping reply on
  // anything. The quoted text below also carries a question mark, so a gate reading the annotated
  // string would veto this turn twice over. (The attachment note, the other annotation, needs no
  // pin: a file that really arrived is already a structural veto in its own right.)
  const chatId = randomUUID();
  const { seen, call } = fakeLane(envelope(['sleep on it']));
  await chat(chatId, 'hmm', emptyMedia(), clientCtx({
    repliedToText: 'six to eight weeks from the north supplier, unless you want the southern yard too?',
  }), call);

  const last = seen[0].messages[seen[0].messages.length - 1];
  assert.ok(String(last.content).startsWith('[replying to your earlier text:'),
    'the annotation really did ride along on the message');
  assert.ok((seen[0].system ?? '').includes(HOOK_HEADING), 'and the turn is still idle');
  assert.equal(receipt('hooks:select')?.idleLayer, 'fast_path', 'decided on the typed word alone');
});
