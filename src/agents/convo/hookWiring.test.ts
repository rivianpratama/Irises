// The rhythm engine, WIRED. persona/hooks.test.ts owns the arithmetic and the rendered bytes; this
// file owns everything that happens around them on a real turn: which section the directive puts in
// the prompt and where, what the two flags cost when they are off, the one corrective re-ask a
// broken quiet turn gets, and the ledger row the turn leaves behind.
//
// Three seams, three shapes of test. The assembler is pure, so those cases are argument tuples. The
// quiet guard calls the model, so those go through the injected `turn.call` seam the promise guard's
// suite uses. The ledger is a store write, so those run end to end against the ephemeral backend —
// including in a GROUP, which is the one place this engine deliberately does not fence itself off.

process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildSystemPromptSections, enforceQuiet, processConvoResult, QUIET_CORRECTION,
  type ChatContext, type ConvoTurnContext, type PersonaTurn,
} from './shared.js';
import { DYN_SECTION_IDS, type SectionId } from './promptSections.js';
import { REACTION_TOOL, DELEGATE_TO_OPS_TOOL } from './tools.js';
import {
  HOOK_WORDS, QUIET_LAW, renderHooksSection,
  type HookDirective, type HookSelectReport, type HookState,
} from '../../persona/hooks.js';
import { getHookState } from '../../db/repositories/hookState.js';
import { groupHandle } from '../../memory/identity.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';
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

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  delete process.env.CONVO_HOOKS_ENABLED;
  delete process.env.MEMORY_THESIS_ENABLED;
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

const HOOK: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], sleepQuiet: false, moments: false, offerAllowed: true,
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
  const full: PersonaTurn = { hooks: HOOK, moments: [], thesis: THESIS };
  const bare = buildSystemPromptSections(...build()).system;

  process.env.CONVO_HOOKS_ENABLED = 'off';
  process.env.MEMORY_THESIS_ENABLED = 'off';
  try {
    assert.equal(buildSystemPromptSections(...build(full)).system, bare, 'both off: nothing is added');
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
    delete process.env.MEMORY_THESIS_ENABLED;
  }
  // …and the comparison has teeth: with the flags at their defaults the same struct changes the
  // prompt in both places.
  const on = buildSystemPromptSections(...build(full)).system;
  assert.notEqual(on, bare);
  assert.ok(on.includes(THESIS));

  // Each flag is read at CALL time and gates only its own section.
  process.env.CONVO_HOOKS_ENABLED = 'off';
  try {
    const hooksOff = buildSystemPromptSections(...build(full)).system;
    assert.ok(hooksOff.includes(THESIS), 'the thesis is not the hook flag\'s business');
    assert.ok(!hooksOff.includes(QUIET_LAW));
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }
});

// ── the quiet guard ──────────────────────────────────────────────────────────

const SENDER = '+15550001111';

function envelope(bubbles: string[], hookKind?: string): LlmResult {
  const status: Record<string, unknown> = {
    mood_label: 'content', mood_shift: 'steady', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'let it be quiet',
  };
  if (hookKind) status.hook_kind = hookKind;
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: null,
      bubbles: bubbles.map(text => ({ text, re: null })),
      status,
    }),
    toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test',
  };
}

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

test('a tapback retry — no bubbles at all — is a legal quiet reply and is accepted', async () => {
  const original = envelope(LOUD);
  const tapback = envelope([]);
  const out = await enforceQuiet({ ...guardArgs(original), turn: turnCtx(async () => tapback) }, LOUD, undefined);
  assert.equal(out.res, tapback);
  assert.equal(quietReceipt()?.resolved, 'quiet');
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
  assert.equal(quietReceipt(), undefined, 'the quiet guard did not even evaluate');
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
