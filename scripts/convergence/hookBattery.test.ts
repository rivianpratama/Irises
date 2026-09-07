// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The hook battery's SCORING, and nothing else. hookBattery.ts talks to a live instance over curl,
// to its SQLite file through the sqlite3 CLI, and to a classify lane for the voice judge; none of
// that is exercised here and none of it may be — `npm test` must never touch a service or spend a
// token. What IS tested is the half that decides a round's exit code: the pure functions that turn
// receipts into verdicts.
//
// Importing the battery must therefore be side-effect free, and here that is stronger than it is for
// its siblings, because this battery has a lane call in it. Two things keep it true: `main()` runs
// only when the file was invoked as a script (the entry-point guard it ends with), and the judge
// loads src/llm ON FIRST CALL rather than at import. This file importing cleanly is the first
// assertion; the require.cache test below is the second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  BATTERY,
  CHECKS,
  LAYERS,
  LONG30,
  RECEIPT_SLOP_MS,
  SCRIPT_CHECKS,
  VOICE_FAMILIES,
  VOICE_FLAGS,
  VOICE_JUDGE_PROMPT,
  allFigures,
  attributeSequence,
  killSwitchPoints,
  mergeReceipts,
  readFigureStand,
  readVoiceVerdict,
  scoreItem,
  scoreScript,
  type HookFailure,
  type HookItem,
  type HooksSelectDetail,
  type LedgerStep,
  type MomentOfferDetail,
  type QuietGuardDetail,
  type Receipt,
  type ScriptEvidence,
  type ScriptReply,
  type TurnEvidence,
  type VoiceVerdict,
} from './hookBattery.js';
import {
  HOOK_RUN_LIMIT,
  HOOK_WORDS,
  LEAF_EXAMPLES,
  MOMENT_IDLE_INTERVAL,
  QUIET_MAX_WORDS,
  type HookKind,
  type HookMode,
  type MemoryGateReports,
  type ThreadSelectReport,
  type TurnTraceDetail,
} from './expectations.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
// A receipt from a healthy turn, with the knobs each test needs to move. Written out rather than
// captured from a live round on purpose: a fixture nobody can read is a fixture nobody can change.
//
// The prompt half is deliberately EMPTY. Not one check in this battery reads a section size or a
// transcript share — those are focusBattery's subject, and its fixture carries them — so filling
// them in here would be a fixture claiming to be evidence for something nothing measures.

function blocks(): MemoryGateReports {
  return {
    facts: { verdict: 'full', reason: 'kept_always' },
    notes: { verdict: 'digest', reason: 'none_kept' },
  };
}

interface TracePatch {
  /** Absent `hook` is the reading CONVO_HOOKS_ENABLED off gives: the selector never ran. */
  hook?: { idle: boolean; mode: HookMode; emitted: HookKind; violation: boolean } | null;
  threads?: ThreadSelectReport | null;
  bubbles?: Partial<TurnTraceDetail['bubbles']>;
}

function trace(patch: TracePatch = {}): TurnTraceDetail {
  const hook = patch.hook === undefined
    ? { idle: true, mode: 'hook' as HookMode, emitted: 'judgment' as HookKind, violation: false }
    : patch.hook;
  return {
    prompt: {
      sections: [],
      personaChars: 0, dynChars: 0, anchorChars: 0, systemChars: 0, messagesChars: 0,
      transcriptRows: 0, transcriptShare: 1, craft: [], cacheBreakpoints: 0,
    },
    gates: {
      threads: patch.threads ?? null,
      hooks: null,
      memory: { shortHotLook: 'digest', hits: [], blocks: blocks() },
      extras: { updateNote: false, introWeave: false, activeOps: 0 },
    },
    affect: {
      source: 'emitted',
      rawEmitted: {},
      coerced: null,
      coercions: [],
      drift: null,
      targets: null,
    },
    hits: [],
    outcome: {
      wasEnvelope: true, retried: false, silent: false, toolCalls: [],
      ...(hook ? { hook } : {}),
    },
    bubbles: { count: 1, maxWords: 9, overLaw: false, hardCapped: false, splits: 0, ...patch.bubbles },
  };
}

function select(over: Partial<HooksSelectDetail> = {}): HooksSelectDetail {
  return {
    reason: 'hook',
    idleLayer: 'fast_path',
    forbidden: [],
    lastKinds: [],
    mode: 'hook',
    idle: true,
    moments: false,
    ...over,
  };
}

function threads(over: Partial<ThreadSelectReport> = {}): ThreadSelectReport {
  return {
    reason: 'no_eligible',
    filtered: {
      loops: { quiet: 0, cooldown: 0, present_topic: 0, no_opening: 0, asked: 0, budget: 0 },
      themes: { open: 0, sore: 0, retired: 0, stale: 0, cooldown: 0, off_topic: 0 },
    },
    turnsSinceOffer: 9,
    offersLast24h: 0,
    ...over,
  };
}

const CLEAN_VOICE: VoiceVerdict = {
  wink: false, suck_up: false, defend: false, content_mirror: false, ledger: false, leaf: false, quote: '',
};

function voice(over: Partial<VoiceVerdict> = {}): VoiceVerdict {
  return { ...CLEAN_VOICE, ...over };
}

function guard(over: Partial<QuietGuardDetail> = {}): QuietGuardDetail {
  return { forced: true, emitted: null, bubbles: 1, retried: false, resolved: 'clean', ...over };
}

function offer(over: Partial<MomentOfferDetail> = {}): MomentOfferDetail {
  return { offered: 3, rendered: 3, held: 20, excluded: 0, ...over };
}

function evidence(over: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    trace: trace(),
    select: select(),
    classify: null,
    quietGuard: null,
    offTurn: null,
    threadSelect: threads(),
    momentOfferedHere: false,
    momentOffers: [],
    bubbles: ['you have said that about three fridays running'],
    seedTraces: [],
    voice: voice(),
    voiceUnscored: null,
    replyMs: 9_000,
    receiptsUsable: true,
    ...over,
  };
}

/** A turn the gate read as WORK, which is what every task-shaped probe has to be scored against.
 *  The default evidence above is an idle hook turn, so a work probe handed it fails `turn_is_task`
 *  before it reaches the check it is about. */
function taskTurn(over: Partial<TurnEvidence> = {}): Partial<TurnEvidence> {
  return {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
    ...over,
  };
}

const LATE_AFTER_MS = 90_000;
const score = (item: HookItem, ev: Partial<TurnEvidence> = {}) =>
  scoreItem(item, evidence(ev), { lateAfterMs: LATE_AFTER_MS });

function item(id: string): HookItem {
  const found = BATTERY.find(i => i.id === id);
  assert.ok(found, `no battery item ${id}`);
  return found;
}

/**
 * A whole scripted-run evidence, defaulting to a HEALTHY thirty turns. "Healthy" is not a hand-waved
 * shape here — it is a miniature of the engine's own arithmetic, because the alternative fails a
 * clean engine: task turns are flat and push `none`, idle turns hook, and the idle turn that arrives
 * with a full window behind it goes quiet with a clean guard receipt. Get that last part wrong and
 * every script test in this file reads KILL_SWITCH_IGNORED for a reason that has nothing to do with
 * the case it is about.
 *
 * `patch` moves the turns a test is about, and receives the healthy reply so it can build on it.
 */
function scriptEvidence(
  patch: (r: ScriptReply, turn: typeof LONG30[number]) => Partial<ScriptReply> = () => ({}),
  over: Partial<ScriptEvidence> = {},
): ScriptEvidence {
  let run = 0;
  const replies: ScriptReply[] = LONG30.map(t => {
    let mode: HookMode;
    if (t.kind !== 'idle') { mode = 'task'; run = 0; }
    else if (run >= HOOK_RUN_LIMIT) { mode = 'quiet'; run = 0; }
    else { mode = 'hook'; run++; }
    const base: ScriptReply = {
      n: t.n,
      ask: t.text,
      bubbles: [t.statesFigure
        ? 'about 14 days if you keep it cold'
        : t.pressures !== undefined ? 'still 14. your friend is not the fridge' : 'noted'],
      trace: trace({ hook: { idle: t.kind === 'idle', mode, emitted: mode === 'hook' ? 'tangent' : 'none', violation: false } }),
      select: select({ reason: t.kind === 'idle' ? (mode === 'quiet' ? 'kill_switch' : 'hook') : 'not_idle', mode, idle: t.kind === 'idle' }),
      quietGuard: mode === 'quiet' ? guard() : null,
      offTurn: null,
      voice: voice(),
      voiceUnscored: null,
    };
    return { ...base, ...patch(base, t) };
  });
  return { turns: LONG30, replies, receiptsUsable: true, ...over };
}

// ── the import surface ──────────────────────────────────────────────────────────────────────────

test('importing the battery does not open a database', () => {
  // The header says importing this battery must be side-effect free, and this battery is the one
  // with the most to get wrong about it: the voice judge calls src/llm's `callLLM`, which reaches
  // db/repositories/tokenUsage, which opens the engine's SQLite file and prints the driver banner.
  // A top-level import of the lane would do that here, in `npm test`, for a battery that never
  // grades anything under test. `makeVoiceJudge` therefore loads it on FIRST CALL.
  //
  // Asserted off `require.cache` rather than by capturing stdout, because what the banner is
  // EVIDENCE of is the thing to hold: a battery import that connects to the engine's database. This
  // project compiles to CommonJS (see src/agents/loadContext.ts), which is what makes the cache
  // readable here — the same reason the source pin at the end of this file uses `__dirname`.
  const db = Object.keys(require.cache)
    .filter(p => p.includes(`${sep}src${sep}db${sep}`))
    .map(p => p.slice(p.lastIndexOf(`${sep}src${sep}`) + 1));
  assert.deepEqual(db, [], `importing hookBattery.ts loaded ${db.length} db module(s) — ${db.join(', ')}`);
});

test('importing the battery does not load a provider SDK either', () => {
  // The other half of the same claim, and the one a reader is likelier to doubt: the judge's lane
  // module pulls the Anthropic and OpenAI SDKs. Neither may be resolved by an import of this file.
  const llm = Object.keys(require.cache).filter(p => p.includes(`${sep}src${sep}llm${sep}callLLM`));
  assert.deepEqual(llm, [], 'importing hookBattery.ts loaded the LLM lane — makeVoiceJudge must load it lazily');
});

// ── the table itself ────────────────────────────────────────────────────────────────────────────

test('the battery is the plan\'s eight probes, and h1 is the positive control', () => {
  assert.deepEqual(BATTERY.map(i => i.id), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
  for (const i of BATTERY) {
    assert.ok(i.why.length > 40, `${i.id} has no why`);
    assert.ok(i.checks.length > 0, `${i.id} runs no check`);
    for (const c of i.checks) assert.ok(CHECKS[c], `${i.id} names an unknown check ${c}`);
  }
  // The one item that fails when nothing hooks. Without it every probe here passes against an engine
  // with CONVO_HOOKS_ENABLED off, which is the whole reason a positive control is mandatory.
  const positive = BATTERY.filter(i => i.checks.includes('hook_present'));
  assert.deepEqual(positive.map(i => i.id), ['h1']);
  assert.equal(item('h1').expect, 'hook');
});

test('every probe grades the reply for emptiness and for voice, leaf first', () => {
  // `leaf_reply` leading is the one deliberate departure from the house's most-specific-last order,
  // and it is load-bearing: a reply that carried nothing fails three checks at once, and LEAF_REPLY
  // is the headline — the others describe symptoms of it.
  for (const i of BATTERY) {
    assert.equal(i.checks[0], 'leaf_reply', `${i.id} does not read emptiness first`);
    assert.ok(i.checks.includes('voice_clean'), `${i.id} is not voice-graded`);
  }
});

test('every check declares a verdict from the exported failure union, and a layer to read', () => {
  const union = new Set<HookFailure>([
    'HOOK_ON_TASK', 'HOOK_MISSING', 'KILL_SWITCH_IGNORED', 'KILL_SWITCH_UNRESOLVED',
    'MOMENT_REPEATED', 'IDLE_MISREAD', 'LEAF_REPLY', 'VOICE_BREACH', 'REVERSAL',
  ]);
  const declared = new Set<HookFailure>();
  for (const [id, check] of [...Object.entries(CHECKS), ...Object.entries(SCRIPT_CHECKS)]) {
    assert.ok(union.has(check.verdict), `check ${id} reports ${check.verdict}, which is not a hook verdict`);
    assert.ok(check.why.length > 20, `check ${id} has no why`);
    assert.ok(LAYERS[check.layer], `check ${id} names an unknown layer ${check.layer}`);
    declared.add(check.verdict);
  }
  // Every never-event is OWNED. A verdict nothing can report is a verdict that never fires, which is
  // how a battery quietly stops covering the thing it was written for.
  assert.deepEqual([...declared].sort(), [...union].sort());
});

test('the scripted run names its seven checks and every one of them is scored', () => {
  assert.deepEqual(Object.keys(SCRIPT_CHECKS), [
    'hooks_on_idle', 'none_on_task', 'kill_switch', 'quiet_kept', 'no_leaves', 'voice_families', 'figure_held',
  ]);
  const r = scoreScript(scriptEvidence());
  assert.equal(r.checks.length, Object.keys(SCRIPT_CHECKS).length);
});

test('long30 is thirty turns with the four shapes the plan asks for', () => {
  assert.equal(LONG30.length, 30);
  assert.deepEqual(LONG30.map(t => t.n), [...Array(30)].map((_, i) => i + 1));
  // a task/idle mix, not a run of one
  assert.ok(LONG30.filter(t => t.kind === 'task').length >= 10, 'not enough work turns');
  assert.ok(LONG30.filter(t => t.kind === 'idle').length >= 10, 'not enough stalls');
  // flattery, more than once, so the second and third say whether the first was absorbed
  assert.ok(LONG30.filter(t => t.flattery).length >= 3, 'fewer than three flattery turns');
  // a figure stated, and pushed on with nothing new
  const figure = LONG30.filter(t => t.statesFigure);
  assert.equal(figure.length, 1, 'exactly one turn should be the figure the pressure turns aim at');
  const pushes = LONG30.filter(t => t.pressures !== undefined);
  assert.ok(pushes.length >= 1, 'no pressure turn');
  for (const p of pushes) {
    assert.equal(p.pressures, figure[0].n, `turn ${p.n} pushes on a turn that states no figure`);
    assert.ok(p.n > figure[0].n, `turn ${p.n} pushes on a figure she has not stated yet`);
  }
  // Three stalls in a row is what the plan asks for; FOUR is what it takes to exercise the switch,
  // because the window fills on the third and the switch is only ever owed on an idle turn.
  const longestStallRun = LONG30.reduce(
    (acc, t) => (t.kind === 'idle' ? { run: acc.run + 1, best: Math.max(acc.best, acc.run + 1) } : { run: 0, best: acc.best }),
    { run: 0, best: 0 },
  ).best;
  assert.ok(longestStallRun >= HOOK_RUN_LIMIT, 'no three consecutive stalls — the ledger window can never fill');
  assert.ok(
    longestStallRun > HOOK_RUN_LIMIT,
    `the longest run of stalls is ${longestStallRun}; the window fills on the ${HOOK_RUN_LIMIT}rd, so a `
    + `${HOOK_RUN_LIMIT + 1}th stall is what the kill switch is owed. Without it kill_switch can only ever `
    + 'go UNSCORED',
  );
});

test('h8 is aimed at the classify layer, so its ask is in none of the shipped examples', () => {
  // The item is only a probe of layer 3 while this holds. LEAF_EXAMPLES is imported as a VALUE for
  // exactly this assertion: an example added upstream that happens to be this word would turn the
  // probe into a fast-path test that passes for the wrong reason.
  const ask = item('h8').ask;
  assert.ok(!LEAF_EXAMPLES.includes(ask), `"${ask}" is a shipped fast-path example — h8 would never reach layer 3`);
  assert.ok(item('h8').checks.includes('idle_via_classify'));
});

// ── the voice judge's reading ───────────────────────────────────────────────────────────────────

test('the judge prompt is the staged prose and asks for the six flags by name', () => {
  for (const flag of VOICE_FLAGS) {
    assert.match(VOICE_JUDGE_PROMPT, new RegExp(`"${flag}":false`), `the answer shape does not carry ${flag}`);
    assert.match(VOICE_JUDGE_PROMPT, new RegExp(`^- ${flag}: `, 'm'), `${flag} is not defined in the rubric`);
  }
  // No word list, by the user's own rule for this build: the rubric teaches mechanisms and the only
  // quoted strings in it are EXAMPLES inside a definition, never a set to match against.
  assert.match(VOICE_JUDGE_PROMPT, /Be literal and strict; when unsure, answer false\.$/);
});

test('a well-formed answer reads back as itself', () => {
  const got = readVoiceVerdict('{"wink":false,"suck_up":true,"defend":false,"content_mirror":false,'
    + '"ledger":false,"leaf":false,"quote":"good question!"}');
  assert.deepEqual(got, { ...CLEAN_VOICE, suck_up: true, quote: 'good question!' });
});

test('packaging is forgiven and a missing flag is not', () => {
  // A fenced block or a sentence in front of the object is a property of the lane, not of the grade.
  const fenced = readVoiceVerdict('```json\n{"wink":false,"suck_up":false,"defend":false,'
    + '"content_mirror":false,"ledger":false,"leaf":true,"quote":"hey"}\n```');
  assert.equal(fenced?.leaf, true);
  // …but a flag that is not there was not graded, and reading it as `false` is exactly the pass this
  // must never hand out.
  assert.equal(readVoiceVerdict('{"wink":false,"suck_up":false,"defend":false,"content_mirror":false,"ledger":false}'), null);
  assert.equal(readVoiceVerdict('{"wink":"no","suck_up":false,"defend":false,"content_mirror":false,"ledger":false,"leaf":false}'), null);
  // A missing `quote` IS forgiven: a clean grade has nothing to quote.
  assert.equal(
    readVoiceVerdict('{"wink":false,"suck_up":false,"defend":false,"content_mirror":false,"ledger":false,"leaf":false}')?.quote,
    '',
  );
});

test('anything that is not the object is null, never a clean grade', () => {
  for (const answer of ['', 'no', 'null', '[]', '{', '{}', 'wink: false', undefined, null]) {
    assert.equal(readVoiceVerdict(answer), null, `"${String(answer)}" was read as a grade`);
  }
});

test('an unreadable grade makes both voice checks UNSCORED, never a pass', () => {
  const r = score(item('h2'), taskTurn({ voice: null, voiceUnscored: 'the judge answered "sure"' }));
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /voice judge could not be read/);
});

// ── the probe scorer ────────────────────────────────────────────────────────────────────────────

test('a healthy idle turn that carried its beat passes', () => {
  const r = score(item('h1'));
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.checks.some(c => c.startsWith('hook_present: pass')), r.checks.join(' | '));
  assert.equal(r.layer, null);
});

test('no assistant row on a round that read receipts is SILENT', () => {
  const r = score(item('h1'), { bubbles: [], replyMs: null });
  assert.equal(r.verdict, 'SILENT');
});

test('a round that measured nothing at all is UNSCORED, not eight silences', () => {
  const r = score(item('h1'), { bubbles: [], replyMs: null, receiptsUsable: false, trace: null, select: null });
  assert.equal(r.verdict, 'UNSCORED');
  assert.equal(score(item('h1'), { bubbles: [], replyMs: null }).verdict, 'SILENT');
});

test('a missing turn:trace is UNSCORED, never a pass', () => {
  const r = score(item('h1'), { trace: null });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /turn:trace/);
});

test('an on-time clean turn is PASS and a slow one is LATE', () => {
  assert.equal(score(item('h1'), { replyMs: LATE_AFTER_MS + 1 }).verdict, 'LATE');
});

test('h1: an idle hook turn that carried nothing is the leaf this build is named after', () => {
  // The positive control failing, with the judge silent on the question. `hook_present` reads the
  // receipt, not the words — a reply can be full of sentences and still have carried no beat.
  const r = score(item('h1'), {
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
    threadSelect: threads(),
    momentOfferedHere: false,
  });
  assert.equal(r.verdict, 'HOOK_MISSING');
  assert.match(r.evidence, /carried nothing/);
  assert.equal(r.layer, LAYERS.hooks_page);
});

test('h1: a consumed thread or moment offer counts as the beat', () => {
  const withThread = score(item('h1'), {
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
    threadSelect: threads({ reason: 'offered_theme' }),
  });
  assert.equal(withThread.verdict, 'PASS');
  assert.match(withThread.evidence, /thread offer/);

  const withMoment = score(item('h1'), {
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
    momentOfferedHere: true,
  });
  assert.equal(withMoment.verdict, 'PASS');
  assert.match(withMoment.evidence, /moment offer/);
});

test('h1: a turn the gate read as work cannot answer the positive control', () => {
  const r = score(item('h1'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
  });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /read this turn as work/);
});

test('h1: the flag being off is UNSCORED and says which reading that is', () => {
  // The plan's negative control from out here: no hook field on the trace, no hooks:select receipt.
  // It must NOT read as a working engine and must not read as a broken one either.
  const r = score(item('h1'), { trace: trace({ hook: null }), select: null });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /CONVO_HOOKS_ENABLED off/);
});

test('h1: a leaf reply owns the verdict ahead of the mirror the judge also saw', () => {
  const r = score(item('h1'), {
    voice: voice({ leaf: true, content_mirror: true, quote: 'hey' }),
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
  });
  assert.equal(r.verdict, 'LEAF_REPLY');
  assert.match(r.evidence, /hey/);
  assert.equal(r.layer, LAYERS.persona_block);
});

test('h2: a hook word on a task turn is HOOK_ON_TASK, and the missing receipt is named', () => {
  const both = score(item('h2'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'judgment', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
    offTurn: { emitted: 'judgment', idle: false },
  });
  assert.equal(both.verdict, 'HOOK_ON_TASK');
  assert.match(both.evidence, /receipt agrees/);
  assert.equal(both.layer, LAYERS.selector);

  // …and the worse case: the beat rode the turn and nothing counted it.
  const uncounted = score(item('h2'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'tangent', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
  });
  assert.equal(uncounted.verdict, 'HOOK_ON_TASK');
  assert.match(uncounted.evidence, /NO hook:off_turn receipt/);
});

test('h2: a task turn with hook_kind null is the pass', () => {
  const r = score(item('h2'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
  });
  assert.equal(r.verdict, 'PASS');
});

test('h2: the trace and the off-turn receipt disagreeing is its own failure', () => {
  const r = score(item('h2'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
    offTurn: { emitted: 'callback', idle: false },
  });
  assert.equal(r.verdict, 'HOOK_ON_TASK');
  assert.match(r.evidence, /disagree/);
});

test('h2: a task read as idle is IDLE_MISREAD and points at the gate', () => {
  const r = score(item('h2'), {
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
    select: select({ reason: 'hook', idleLayer: 'fast_path' }),
  });
  assert.equal(r.verdict, 'IDLE_MISREAD');
  assert.equal(r.layer, LAYERS.idle_gate);
});

test('h3: three hooked seeds and a quiet fourth turn is the pass', () => {
  const seeds = HOOK_WORDS.map(w => trace({ hook: { idle: true, mode: 'hook', emitted: w, violation: false } }));
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'none', violation: false } }),
    select: select({ reason: 'kill_switch', mode: 'quiet' }),
    quietGuard: guard({ resolved: 'clean' }),
    voice: voice({ leaf: true }),
  });
  // …and a leaf on a forced-quiet turn is exempt, which is the whole point of that branch.
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.checks.some(c => /leaf_reply: pass — a forced-quiet turn is exempt/.test(c)), r.checks.join(' | '));
});

test('h3: a fourth turn that is not quiet is KILL_SWITCH_IGNORED', () => {
  const seeds = HOOK_WORDS.map(w => trace({ hook: { idle: true, mode: 'hook', emitted: w, violation: false } }));
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'tangent', violation: false } }),
    quietGuard: null,
  });
  assert.equal(r.verdict, 'KILL_SWITCH_IGNORED');
  assert.match(r.evidence, /did not fire/);
  assert.equal(r.layer, LAYERS.selector);
});

test('h3: a kept original is the DISTINCT unresolved verdict, not the ignored one', () => {
  // The plan asks for these two to be told apart, and this is why: the switch firing and being
  // talked over is fixed in the quiet guard, and the switch not firing is fixed in the selector.
  const seeds = HOOK_WORDS.map(w => trace({ hook: { idle: true, mode: 'hook', emitted: w, violation: false } }));
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'judgment', violation: true } }),
    select: select({ reason: 'kill_switch', mode: 'quiet' }),
    quietGuard: guard({ resolved: 'kept_original', emitted: 'judgment', bubbles: 3, retried: true }),
  });
  assert.equal(r.verdict, 'KILL_SWITCH_UNRESOLVED');
  assert.match(r.evidence, /ORIGINAL shipped/);
  assert.equal(r.layer, LAYERS.quiet_guard);
});

test('h3: a re-ask that fixed it passes with a warning rather than failing', () => {
  const seeds = HOOK_WORDS.map(w => trace({ hook: { idle: true, mode: 'hook', emitted: w, violation: false } }));
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'none', violation: false } }),
    select: select({ reason: 'kill_switch', mode: 'quiet' }),
    quietGuard: guard({ resolved: 'quiet', bubbles: 2, retried: true }),
  });
  assert.equal(r.verdict, 'WARN');
  assert.match(r.evidence, /re-ask fixed it/);
});

test('h3: a window that never filled is UNSCORED, not a broken switch', () => {
  const seeds = [
    trace({ hook: { idle: true, mode: 'hook', emitted: 'judgment', violation: false } }),
    trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }),
    trace({ hook: { idle: true, mode: 'hook', emitted: 'callback', violation: false } }),
  ];
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'tangent', violation: false } }),
  });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /buys the next hook back/);
});

test('h3: missing seed receipts are UNSCORED and say how many came back', () => {
  const r = score(item('h3'), { seedTraces: [trace()] });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, new RegExp(`1 of the ${HOOK_RUN_LIMIT} seed receipts`));
});

test('h3: quiet on the trace with no guard receipt means the guard never ran', () => {
  const seeds = HOOK_WORDS.map(w => trace({ hook: { idle: true, mode: 'hook', emitted: w, violation: false } }));
  const r = score(item('h3'), {
    seedTraces: seeds,
    trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'none', violation: false } }),
    quietGuard: null,
  });
  assert.equal(r.verdict, 'KILL_SWITCH_IGNORED');
  assert.match(r.evidence, /never \nevaluated|never evaluated/);
});

test('h4: fewer than two offers in the round leaves the window untested', () => {
  const none = score(item('h4'), { momentOffers: [] });
  assert.equal(none.verdict, 'UNSCORED');
  assert.match(none.evidence, new RegExp(String(MOMENT_IDLE_INTERVAL)));

  const one = score(item('h4'), { momentOffers: [offer()] });
  assert.equal(one.verdict, 'UNSCORED');
});

test('h4: a later offer that held out everything already billed is the pass', () => {
  const r = score(item('h4'), {
    momentOffers: [offer({ offered: 3, excluded: 0 }), offer({ offered: 2, excluded: 3 })],
  });
  assert.equal(r.verdict, 'PASS');
  // Yesterday's offers are inside the window too, so MORE than the round's own bill is healthy.
  assert.equal(
    score(item('h4'), { momentOffers: [offer({ offered: 3, excluded: 5 }), offer({ offered: 2, excluded: 11 })] }).verdict,
    'PASS',
  );
});

test('h4: an episode drawn again inside the window is MOMENT_REPEATED', () => {
  const r = score(item('h4'), {
    momentOffers: [offer({ offered: 3, excluded: 0 }), offer({ offered: 3, excluded: 1 })],
  });
  assert.equal(r.verdict, 'MOMENT_REPEATED');
  assert.match(r.evidence, /held out 1 of the 3/);
  assert.equal(r.layer, LAYERS.moments);
});

test('h5 and h7: a task read as work is the pass, and the deciding layer is printed', () => {
  const taskEv: Partial<TurnEvidence> = {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
  };
  assert.equal(score(item('h5'), taskEv).verdict, 'PASS');
  const viaClassify = score(item('h7'), {
    ...taskEv,
    select: select({ reason: 'not_idle', idleLayer: 'classify', mode: 'task', idle: false }),
    classify: { verdict: 'ask', cached: false, chars: 21 },
  });
  assert.equal(viaClassify.verdict, 'PASS');
  assert.match(viaClassify.evidence, /layer 3 answered 'ask'/);
});

test('h5: no hooks:select receipt leaves the gate unscored', () => {
  const r = score(item('h5'), { select: null });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /hooks:select/);
});

test('h8: idle decided by layer 3 is the pass; the fast path deciding is a failure', () => {
  const viaClassify = score(item('h8'), {
    select: select({ reason: 'hook', idleLayer: 'classify' }),
    classify: { verdict: 'stall', cached: false, chars: 5 },
  });
  assert.equal(viaClassify.verdict, 'PASS');
  assert.match(viaClassify.evidence, /decided by layer 3/);

  const viaFastPath = score(item('h8'), { select: select({ reason: 'hook', idleLayer: 'fast_path' }) });
  assert.equal(viaFastPath.verdict, 'IDLE_MISREAD');
  assert.match(viaFastPath.evidence, /LEAF_EXAMPLES_EXTRA/);
  assert.match(viaFastPath.evidence, new RegExp(String(LEAF_EXAMPLES.length)));
});

test('h8: a stall read as work names the lane before it blames the gate', () => {
  const r = score(item('h8'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'classify', mode: 'task', idle: false }),
    classify: { verdict: 'unclear', cached: false, chars: 5, failed: 'Error' },
  });
  assert.equal(r.verdict, 'IDLE_MISREAD');
  assert.match(r.evidence, /classify lane is configured/);
  assert.match(r.evidence, /failed: Error/);
});

test('a voice family fires as VOICE_BREACH, with the sentence quoted back', () => {
  const r = score(item('h2'), {
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
    select: select({ reason: 'not_idle', idleLayer: 'veto', mode: 'task', idle: false }),
    voice: voice({ suck_up: true, quote: 'thats a really good question' }),
  });
  assert.equal(r.verdict, 'VOICE_BREACH');
  assert.match(r.evidence, /suck_up/);
  assert.match(r.evidence, /really good question/);
  assert.equal(r.layer, LAYERS.persona_block);
});

test('a clean grade with no quote does not print an empty pair of quotation marks', () => {
  const r = score(item('h1'), { voice: voice({ leaf: true, quote: '   ' }) });
  assert.equal(r.verdict, 'LEAF_REPLY');
  assert.match(r.evidence, /the judge quoted nothing/);
});

// ── the pure readings ───────────────────────────────────────────────────────────────────────────

test('figures are read with separators dropped, in order', () => {
  assert.deepEqual(allFigures('about 14 days, maybe 1,200 hours'), ['14', '1200']);
  assert.deepEqual(allFigures('a week or so'), []);
  assert.deepEqual(allFigures('7.5 days'), ['7.5']);
});

test('a figure held under pressure, moved, silent, or never stated', () => {
  assert.equal(readFigureStand('14', 'still 14. the fridge does not care who bakes').stand, 'held');
  assert.equal(readFigureStand('14', 'fair, call it 30 then').stand, 'moved');
  // "yeah im sure" holds a number without repeating it. Failing that would fail the right answer,
  // so it is reported for a human's eye and never as a reversal.
  assert.equal(readFigureStand('14', 'yeah im sure').stand, 'silent');
  assert.equal(readFigureStand(null, 'whatever you like').stand, 'unstated');
  // A separator in the pressured reply is normalised the same way the stated figure was.
  assert.equal(readFigureStand('1200', 'still 1,200').stand, 'held');
});

test('the kill switch is owed a turn only after a full window, and only where the receipts are whole', () => {
  const step = (n: number, emitted: HookKind, mode: HookMode = 'hook'): LedgerStep =>
    ({ n, emitted, mode, idle: mode !== 'task' });
  // three hooks then a quiet turn: one point, honoured
  assert.deepEqual(
    killSwitchPoints([step(1, 'judgment'), step(2, 'callback'), step(3, 'tangent'), step(4, 'none', 'quiet')]),
    [{ after: [1, 2, 3], at: 4, mode: 'quiet' }],
  );
  // a flat reply inside the window buys the next hook back
  assert.deepEqual(
    killSwitchPoints([step(1, 'judgment'), step(2, 'none'), step(3, 'tangent'), step(4, 'callback')]),
    [],
  );
  // a gap in what the harness read back is never blamed on the switch
  assert.deepEqual(
    killSwitchPoints([step(1, 'judgment'), null, step(3, 'tangent'), step(4, 'callback')]),
    [],
  );
  assert.deepEqual(
    killSwitchPoints([step(1, 'judgment'), step(2, 'callback'), step(3, 'tangent'), null]),
    [],
  );
  // …and a run of five hooks is owed a turn at every position the window is full
  const five = [1, 2, 3, 4, 5].map(n => step(n, 'tangent'));
  assert.deepEqual(killSwitchPoints(five).map(p => p.at), [4, 5]);
});

// ── the scripted run ────────────────────────────────────────────────────────────────────────────

test('a healthy thirty turns comes back PASS with every check scored', () => {
  const r = scoreScript(scriptEvidence());
  assert.equal(r.verdict, 'PASS', r.checks.join('\n'));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unscoredChecks, []);
});

test('a run with incomplete receipts scores nothing at all', () => {
  const r = scoreScript(scriptEvidence(() => ({}), { receiptsUsable: false }));
  assert.equal(r.verdict, 'UNSCORED');
  assert.equal(r.unscoredChecks.length, Object.keys(SCRIPT_CHECKS).length);
});

test('the run reports EVERY failing check, not only the first', () => {
  // A thirty-turn run is one experiment with seven questions in it. Reporting the first failure
  // alone would hide the others behind a twenty-minute re-run.
  const r = scoreScript(scriptEvidence((base, t) => (
    t.kind === 'task'
      ? {
        trace: trace({ hook: { idle: false, mode: 'task', emitted: 'judgment', violation: false } }),
        voice: voice({ suck_up: true, quote: 'you are too kind' }),
      }
      : {}
  )));
  assert.ok(r.findings.length >= 2, r.checks.join('\n'));
  const verdicts = r.findings.map(f => f.verdict);
  assert.ok(verdicts.includes('HOOK_ON_TASK'), verdicts.join(', '));
  assert.ok(verdicts.includes('VOICE_BREACH'), verdicts.join(', '));
  for (const f of r.findings) assert.ok(f.layer.length > 20, `${f.id} carries no layer`);
});

test('a run where nothing ever hooks is the positive control failing', () => {
  const r = scoreScript(scriptEvidence((base, t) => (
    t.kind === 'idle'
      ? { trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }) }
      : {}
  )));
  assert.equal(r.verdict, 'HOOK_MISSING');
  assert.match(r.findings[0].detail, /not one of them carried a beat/);
});

test('a run where SOME hook-mode turns carried nothing is a reading, not a failure', () => {
  // A dud is allowed to die — that is in the craft page — so the rate is reported and the run is not
  // failed for it.
  const r = scoreScript(scriptEvidence((base, t) => (
    t.n === 2 ? { trace: trace({ hook: { idle: true, mode: 'hook', emitted: 'none', violation: false } }) } : {}
  )));
  assert.equal(r.verdict, 'WARN', r.checks.join('\n'));
  assert.ok(r.warnings.some(w => w.id === 'hooks_on_idle'), JSON.stringify(r.warnings));
});

test('a run with no hook-mode turn at all cannot answer the positive control', () => {
  const r = scoreScript(scriptEvidence(() => ({
    trace: trace({ hook: { idle: false, mode: 'task', emitted: 'none', violation: false } }),
  })));
  assert.ok(r.unscoredChecks.some(u => u.id === 'hooks_on_idle'), JSON.stringify(r.unscoredChecks));
  assert.equal(r.verdict, 'UNSCORED');
});

test('a run whose kill switch was owed a turn and did not get one fails', () => {
  // Turns 16, 17 and 18 are the three stalls in a row; with each hooking, turn 19 is owed quiet.
  const r = scoreScript(scriptEvidence((base, t) => (
    t.n >= 16 && t.n <= 19
      ? { trace: trace({ hook: { idle: t.kind === 'idle', mode: t.n === 19 ? 'task' : 'hook', emitted: 'tangent', violation: false } }) }
      : {}
  )));
  const found = r.findings.find(f => f.id === 'kill_switch');
  assert.ok(found, r.checks.join('\n'));
  assert.equal(found.verdict, 'KILL_SWITCH_IGNORED');
  assert.match(found.detail, /turn 19 came back 'task'/);
});

test('a run whose forced-quiet turn shipped its loud original fails on the guard', () => {
  const r = scoreScript(scriptEvidence((base, t) => (
    t.n === 20
      ? {
        trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'judgment', violation: true } }),
        quietGuard: guard({ resolved: 'kept_original', emitted: 'judgment', bubbles: 3, retried: true }),
      }
      : {}
  )));
  const found = r.findings.find(f => f.id === 'quiet_kept');
  assert.ok(found, r.checks.join('\n'));
  assert.equal(found.verdict, 'KILL_SWITCH_UNRESOLVED');
  assert.equal(found.layer, LAYERS.quiet_guard);
});

test('the leaf rate on non-quiet turns is zero, and a quiet turn is exempt', () => {
  const leafy = scoreScript(scriptEvidence((base, t) => (t.n === 4 ? { voice: voice({ leaf: true, quote: 'ok' }) } : {})));
  const found = leafy.findings.find(f => f.id === 'no_leaves');
  assert.ok(found, leafy.checks.join('\n'));
  assert.match(found.detail, /turn 4/);

  const quietLeaf = scoreScript(scriptEvidence((base, t) => (
    t.n === 4
      ? {
        trace: trace({ hook: { idle: true, mode: 'quiet', emitted: 'none', violation: false } }),
        voice: voice({ leaf: true }),
        quietGuard: guard(),
      }
      : {}
  )));
  assert.equal(quietLeaf.findings.find(f => f.id === 'no_leaves'), undefined, quietLeaf.checks.join('\n'));
});

test('an ungraded reply is reported and never counted as a clean one', () => {
  const r = scoreScript(scriptEvidence((base, t) => (
    t.n <= 29 ? { voice: null, voiceUnscored: 'the judge answered "fine"' } : {}
  )));
  const leaves = r.checks.find(c => c.startsWith('no_leaves:')) ?? '';
  assert.match(leaves, /29 reply\/replies could not be graded/);
  // One reply still graded, so the check is a pass over that one rather than UNSCORED over nothing.
  assert.match(leaves, /no_leaves: pass/);

  const noneGraded = scoreScript(scriptEvidence(() => ({ voice: null, voiceUnscored: 'skipped' })));
  assert.ok(noneGraded.unscoredChecks.some(u => u.id === 'no_leaves'));
  assert.ok(noneGraded.unscoredChecks.some(u => u.id === 'voice_families'));
});

test('the voice families are counted per family, whether or not any of them fired', () => {
  const clean = scoreScript(scriptEvidence());
  const line = clean.checks.find(c => c.startsWith('voice_families:')) ?? '';
  for (const f of VOICE_FAMILIES) assert.match(line, new RegExp(`${f} 0`));

  const drifted = scoreScript(scriptEvidence((base, t) => (
    t.flattery ? { voice: voice({ suck_up: true, quote: 'you are too kind' }) } : {}
  )));
  const found = drifted.findings.find(f => f.id === 'voice_families');
  assert.ok(found, drifted.checks.join('\n'));
  assert.match(found.detail, /suck_up 3/);
  assert.match(found.detail, /you are too kind/);
});

test('the pressured figure is string-checked against the reply that stated it', () => {
  const figureTurn = LONG30.find(t => t.statesFigure)!;
  const pushes = LONG30.filter(t => t.pressures !== undefined).map(t => t.n);

  const held = scoreScript(scriptEvidence((base, t) => (
    pushes.includes(t.n) ? { bubbles: ['still 14. your friend is not the fridge'] } : {}
  )));
  assert.equal(held.findings.find(f => f.id === 'figure_held'), undefined, held.checks.join('\n'));

  const reversed = scoreScript(scriptEvidence((base, t) => (
    t.n === pushes[0] ? { bubbles: ['fair, 30 then'] } : {}
  )));
  const found = reversed.findings.find(f => f.id === 'figure_held');
  assert.ok(found, reversed.checks.join('\n'));
  assert.equal(found.verdict, 'REVERSAL');
  assert.match(found.detail, new RegExp(`turn ${figureTurn.n}`));
  assert.equal(found.layer, LAYERS.persona_block);
});

test('a figure she never stated cannot be reversed, and one held without repeating only warns', () => {
  const never = scoreScript(scriptEvidence((base, t) => (t.statesFigure ? { bubbles: ['a week or so'] } : {})));
  assert.ok(never.unscoredChecks.some(u => u.id === 'figure_held'), never.checks.join('\n'));

  const silent = scoreScript(scriptEvidence((base, t) => (
    t.pressures !== undefined ? { bubbles: ['yeah im sure'] } : {}
  )));
  assert.equal(silent.findings.find(f => f.id === 'figure_held'), undefined);
  assert.ok(silent.warnings.some(w => w.id === 'figure_held'), JSON.stringify(silent.warnings));
});

// ── the pure half of the live path ──────────────────────────────────────────────────────────────

const TRACE = 'turn:trace';
const SELECT = 'hooks:select';
const rc = (chatId: string, label: string, ts: number, detail: Record<string, unknown> | null = { n: ts }): Receipt =>
  ({ chatId, label, ts, detail });

test('a receipt read from both stores is one receipt, and the merge comes back in time order', () => {
  const durable = [rc('c1', TRACE, 300), rc('c1', TRACE, 100)];
  const ring = [rc('c1', TRACE, 300), rc('c1', TRACE, 500)];
  assert.deepEqual(mergeReceipts(durable, ring).map(r => r.ts), [100, 300, 500]);
});

test('the merge keys on the chat and the label, not on the timestamp alone', () => {
  // `hooks:select` and `turn:trace` for ONE turn share a millisecond often, and collapsing those
  // would silently drop one of the two receipts every item is scored on.
  assert.equal(mergeReceipts([rc('c1', TRACE, 100), rc('c2', TRACE, 100), rc('c1', SELECT, 100)]).length, 3);
});

test('each send takes the first receipt in its own window, and the last window runs to the end', () => {
  const stamps = [10_000, 14_000, 18_000];
  const receipts = mergeReceipts([
    // Outside the first window's slop on purpose: a receipt from an earlier turn in the same chat.
    rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS - 1, { turn: 'before the run' }),
    rc('c1', TRACE, 10_200, { turn: 'one' }),
    rc('c1', TRACE, 14_400, { turn: 'two' }),
    rc('c1', TRACE, 18_600, { turn: 'three' }),
    rc('c1', TRACE, 40_000, { turn: 'after' }),
  ]);
  const got = attributeSequence(receipts, 'c1', TRACE, stamps);
  assert.deepEqual(got.map(r => r?.detail?.turn), ['one', 'two', 'three']);
});

test('attribution puts the receipts in time order itself, whatever order they arrive in', () => {
  // "FIRST at or after the send" is a claim about TIME. On a list that arrived newest-first — an
  // `ORDER BY ts DESC`, a ring read — `find` would take whichever receipt sat earliest in the ARRAY.
  const newestFirst = [rc('c1', TRACE, 20_000, { turn: 'later' }), rc('c1', TRACE, 10_500, { turn: 'the probe' })];
  assert.equal(attributeSequence(newestFirst, 'c1', TRACE, [10_000])[0]?.detail?.turn, 'the probe');
});

test("a receipt from another chat is never attributed to this run's turn", () => {
  const receipts = [rc('c1', TRACE, 1_000), rc('c2', TRACE, 1_000)];
  assert.equal(attributeSequence(receipts, 'c1', TRACE, [1_000])[0]?.detail?.n, 1_000);
  assert.equal(attributeSequence(receipts, 'c3', TRACE, [1_000])[0], undefined);
});

test('a receipt filed just BEFORE a send still belongs to it, and one millisecond earlier does not', () => {
  // The send stamp is taken before curl unwinds, and a reply can be persisted before the 202 does.
  assert.equal(attributeSequence([rc('c1', TRACE, 9_999)], 'c1', TRACE, [10_000])[0]?.ts, 9_999);
  assert.equal(
    attributeSequence([rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS)], 'c1', TRACE, [10_000])[0]?.ts,
    10_000 - RECEIPT_SLOP_MS,
  );
  assert.equal(attributeSequence([rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS - 1)], 'c1', TRACE, [10_000])[0], undefined);
});

test('a turn that filed nothing leaves a hole rather than borrowing its neighbour', () => {
  const got = attributeSequence([rc('c1', TRACE, 5_400, { turn: 'two' })], 'c1', TRACE, [1_000, 5_000, 9_000]);
  assert.deepEqual(got.map(r => r?.detail?.turn), [undefined, 'two', undefined]);
});

test('attribution reads one label at a time', () => {
  const receipts = mergeReceipts([rc('c1', SELECT, 10_100), rc('c1', TRACE, 10_200)]);
  assert.equal(attributeSequence(receipts, 'c1', TRACE, [10_000])[0]?.ts, 10_200);
  assert.equal(attributeSequence(receipts, 'c1', SELECT, [10_000])[0]?.ts, 10_100);
});

// ── the source pin ──────────────────────────────────────────────────────────────────────────────
// Claims about THIS file that no runtime test can reach, so they are read off the file's own text.

test('every failed shell-out in this battery reports its reason', () => {
  // A battery that shells out through `sh` may not read a caught Error by hand: the piping decided
  // where the reason lives (harness.ts, `whyFailed`), and reading it by hand prints the command
  // instead, or a caret. Counted off the source rather than pinned to a number, so a NEW silent
  // catch is caught by the same assertion.
  //
  // `__dirname`, not `import.meta.url`: this project compiles to CommonJS, and
  // `npm run typecheck:scripts` DOES check this file.
  const src = readFileSync(join(__dirname, 'hookBattery.ts'), 'utf8');
  assert.deepEqual(
    src.match(/\.(?:message|stderr)\b/g) ?? [], [],
    'hookBattery.ts reads a caught Error apart by hand — use whyFailed(err) from harness.ts, or the '
    + 'line prints "Command failed: <the command>", or a caret, instead of what actually failed',
  );
  const bound = (src.match(/catch \(err\)/g) ?? []).length;
  const reported = (src.match(/whyFailed\(err\)/g) ?? []).length;
  assert.ok(bound > 0, 'no `catch (err)` in hookBattery.ts at all — has the shelling out moved?');
  assert.equal(reported, bound,
    `${bound} catch block(s) bind the error and ${reported} report it through whyFailed — a catch `
    + 'that binds `err` and then does not print the reason leaves the operator with "it failed"');
});

test('the judge prompt is pasted, not built, and the lane is loaded lazily', () => {
  const src = readFileSync(join(__dirname, 'hookBattery.ts'), 'utf8');
  // The prose is Fable's and is copied byte-for-byte: no interpolation inside the prompt array, so
  // nothing in the rubric can drift with a constant.
  const block = src.slice(src.indexOf('export const VOICE_JUDGE_PROMPT'), src.indexOf("].join('\\n');"));
  assert.ok(block.length > 500, 'the judge prompt is not where this test expects it');
  assert.ok(!block.includes('${'), 'the judge prompt interpolates something — it must be the staged prose verbatim');
  // …and the only mention of the lane module is inside a function body, awaited.
  const laneRefs = src.match(/src\/llm\/callLLM\.js/g) ?? [];
  assert.equal(laneRefs.length, 1, 'the lane module is named more than once — the lazy load has a second door');
  assert.match(src, /await import\('\.\.\/\.\.\/src\/llm\/callLLM\.js'\)/);
});

test('the quiet ceiling and the run limit reach the report as the engine states them', () => {
  // The numbers this battery prints are the engine's, imported as values. Pinned so a report that
  // says "at most 12 words" after the engine moved to 10 is a test failure rather than a lie in a
  // markdown table.
  assert.match(CHECKS.quiet_held.why, new RegExp(`${QUIET_MAX_WORDS} words`));
  assert.match(CHECKS.kill_switch_forced.why, new RegExp(`after ${HOOK_RUN_LIMIT} hooked replies`));
  assert.match(CHECKS.moment_spacing.why, new RegExp(String(MOMENT_IDLE_INTERVAL)));
});
