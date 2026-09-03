// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The focus battery's SCORING, and nothing else. focusBattery.ts talks to a live instance over curl
// and to its SQLite file through the sqlite3 CLI; none of that is exercised here and none of it may
// be — `npm test` must never touch a service or spend a token. What IS tested is the half that
// decides a round's exit code: the pure functions that turn one turn's receipts into one verdict.
//
// Importing the battery must therefore be side-effect free. It is: `main()` runs only when that file
// was invoked as a script (the entry-point guard it ends with), and this file importing cleanly is
// the assertion — if that guard ever breaks, this test file starts a live round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTERY,
  CHECKS,
  scoreItem,
  themesTouchedBy,
  unknownSections,
  type FocusItem,
  type TurnEvidence,
} from './focusBattery.js';
import {
  DATA_BUDGET_KEYS,
  LOOP_OPENING_GAP_MS,
  PROSE_BUDGET_KEYS,
  PROMPT_BUDGET,
  MAX_BUBBLE_WORDS,
  THREAD_MIN_TURNS_BETWEEN_OFFERS,
  type BudgetKey,
  type MemoryGateReports,
  type ThreadSelectReport,
  type ThreadTheme,
  type TurnTraceDetail,
} from './expectations.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
// A receipt from a healthy turn, with the knobs each test needs to move. Written out rather than
// captured from a live round on purpose: a fixture nobody can read is a fixture nobody can change.

function sections(over?: Partial<Record<BudgetKey, number>>): TurnTraceDetail['prompt']['sections'] {
  const base: Array<[BudgetKey, number]> = [
    ['persona', 138_102],
    ['status_contract', 3_976],
    ['context_block', 6_000],
    ['current_time', 291],
    ['turn_focus', 544],
    ['behavior_anchor', 699],
    ['json_anchor', 2_908],
  ];
  return base.map(([name, chars]) => ({ name, chars: over?.[name] ?? chars })) as TurnTraceDetail['prompt']['sections'];
}

function blocks(over?: MemoryGateReports): MemoryGateReports {
  return {
    emails: { verdict: 'dropped', reason: 'nothing_held' },
    notes: { verdict: 'digest', reason: 'none_kept' },
    facts: { verdict: 'full', reason: 'kept_always' },
    long: { verdict: 'digest', reason: 'partly_kept' },
    directives: { verdict: 'full', reason: 'all_kept' },
    clarification: { verdict: 'dropped', reason: 'nothing_held' },
    update_note: { verdict: 'dropped', reason: 'mid_conversation' },
    ...over,
  };
}

interface TracePatch {
  sectionsOver?: Partial<Record<BudgetKey, number>>;
  bubbles?: Partial<TurnTraceDetail['bubbles']>;
  shortHotLook?: TurnTraceDetail['gates']['memory']['shortHotLook'];
  hits?: TurnTraceDetail['gates']['memory']['hits'];
  blocksOver?: MemoryGateReports;
  affectSource?: TurnTraceDetail['affect']['source'];
  moodLevel?: number;
}

function trace(patch: TracePatch = {}): TurnTraceDetail {
  return {
    prompt: {
      sections: sections(patch.sectionsOver),
      personaChars: 138_102,
      dynChars: 11_000,
      anchorChars: 2_908,
      systemChars: 152_600,
      messagesChars: 1_207,
      transcriptRows: 8,
      transcriptShare: 0.0079,
    },
    gates: {
      threads: null,
      memory: {
        shortHotLook: patch.shortHotLook ?? 'digest',
        hits: patch.hits ?? [{ label: 'sourdough starter', kind: 'note' }],
        blocks: blocks(patch.blocksOver),
      },
      extras: { updateNote: false, introWeave: false, activeOps: 0 },
    },
    affect: {
      source: patch.affectSource ?? 'emitted',
      rawEmitted: { mood_level: patch.moodLevel ?? 60 },
      coerced: { mood_level: patch.moodLevel ?? 60 } as unknown as TurnTraceDetail['affect']['coerced'],
      coercions: [],
    },
    hits: ['sourdough starter'],
    outcome: { wasEnvelope: true, retried: false, silent: false, toolCalls: [] },
    bubbles: { count: 2, maxWords: 11, overLaw: false, hardCapped: false, splits: 0, ...patch.bubbles },
  };
}

function select(over: Partial<ThreadSelectReport> = {}): ThreadSelectReport {
  return {
    reason: 'no_eligible',
    filtered: {
      loops: { quiet: 0, cooldown: 0, present_topic: 0, no_opening: 0, asked: 0, budget: 0 },
      themes: { open: 0, sore: 0, retired: 0, stale: 0, cooldown: 0, off_topic: 0 },
      ...over.filtered,
    },
    turnsSinceOffer: 9,
    offersLast24h: 0,
    ...over,
  };
}

function evidence(over: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    trace: trace(),
    select: select(),
    bubbles: ['keep it in a warm spot', 'and feed it twice a day'],
    seedTraces: [],
    seedTokens: [],
    touchedThemes: [],
    replyMs: 9_000,
    receiptsUsable: true,
    ...over,
  };
}

const LATE_AFTER_MS = 90_000;
const score = (item: FocusItem, ev: Partial<TurnEvidence> = {}) =>
  scoreItem(item, evidence(ev), { lateAfterMs: LATE_AFTER_MS });

function item(id: string): FocusItem {
  const found = BATTERY.find(i => i.id === id);
  assert.ok(found, `no battery item ${id}`);
  return found;
}

// ── the table itself ────────────────────────────────────────────────────────────────────────────

test('the battery is the plan\'s nine sendable probes, f10 riding on every one of them', () => {
  assert.deepEqual(BATTERY.map(i => i.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']);
  for (const i of BATTERY) {
    assert.ok(i.checks.includes('bubble_law'), `${i.id} does not carry the f10 bubble-law check`);
    assert.ok(i.why.length > 40, `${i.id} has no why`);
    for (const c of i.checks) assert.ok(CHECKS[c], `${i.id} names an unknown check ${c}`);
  }
});

test('every check declares a verdict from the exported failure union', () => {
  const union = new Set([
    'OFF_TOPIC_LEAK', 'MEMORY_DUMP', 'RE_DELIVERY', 'BUDGET_BREACH',
    'INTERVIEW', 'DIRECTIVE_LOST', 'CONNECTION_MISSED', 'AFFECT_UNBOUNDED',
  ]);
  for (const [id, check] of Object.entries(CHECKS)) {
    assert.ok(union.has(check.verdict), `check ${id} reports ${check.verdict}, which is not a focus verdict`);
    assert.ok(check.why.length > 20, `check ${id} has no why`);
  }
});

test('the budget split covers every PROMPT_BUDGET key exactly once', () => {
  const all = Object.keys(PROMPT_BUDGET).sort();
  const split = [...DATA_BUDGET_KEYS, ...PROSE_BUDGET_KEYS].sort();
  assert.deepEqual(split, all);
  assert.equal(new Set(split).size, split.length);
});

// ── the scorer ──────────────────────────────────────────────────────────────────────────────────

test('a healthy on-topic turn passes', () => {
  const r = score(item('f1'));
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.checks.some(c => c.startsWith('bubble_law: pass')), r.checks.join(' | '));
});

test('no assistant row at all is SILENT, whatever the receipts say', () => {
  const r = score(item('f1'), { bubbles: [], replyMs: null });
  assert.equal(r.verdict, 'SILENT');
});

test('a missing turn:trace is UNSCORED, never a pass', () => {
  const r = score(item('f1'), { trace: null });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /turn:trace/);
});

test('incomplete receipts are UNSCORED before any check runs', () => {
  const r = score(item('f1'), { receiptsUsable: false });
  assert.equal(r.verdict, 'UNSCORED');
});

test('an on-time clean turn is PASS and a slow one is LATE', () => {
  assert.equal(score(item('f1'), { replyMs: LATE_AFTER_MS + 1 }).verdict, 'LATE');
});

test('f10: the bubble law fails on the count, the words and the runaway guard', () => {
  assert.equal(score(item('f1'), { trace: trace({ bubbles: { overLaw: true, count: 4 } }) }).verdict, 'BUDGET_BREACH');
  assert.equal(
    score(item('f1'), { trace: trace({ bubbles: { maxWords: MAX_BUBBLE_WORDS + 1 } }) }).verdict,
    'BUDGET_BREACH',
  );
  assert.equal(score(item('f1'), { trace: trace({ bubbles: { hardCapped: true } }) }).verdict, 'BUDGET_BREACH');
});

test('a prose section over its ceiling fails and names the key; a data section only warns', () => {
  const prose = score(item('f1'), { trace: trace({ sectionsOver: { status_contract: PROMPT_BUDGET.status_contract + 1 } }) });
  assert.equal(prose.verdict, 'BUDGET_BREACH');
  assert.match(prose.evidence, /status_contract/);

  const data = score(item('f1'), { trace: trace({ sectionsOver: { context_block: PROMPT_BUDGET.context_block * 3 } }) });
  assert.notEqual(data.verdict, 'BUDGET_BREACH');
  assert.ok(data.checks.some(c => /memory_ceiling: warn/.test(c)), data.checks.join(' | '));
});

test('MEMORY_DUMP: nothing touched the turn and the notes still rendered whole', () => {
  const r = score(item('f1'), {
    trace: trace({ hits: [], blocksOver: { notes: { verdict: 'full', reason: 'all_kept' } } }),
  });
  assert.equal(r.verdict, 'MEMORY_DUMP');
  assert.match(r.evidence, /notes/);
});

test('the facts block rendering whole with no hits is not a dump — it is ungated by design', () => {
  const r = score(item('f1'), { trace: trace({ hits: [] }) });
  assert.equal(r.verdict, 'PASS');
});

test('f1: a callback-shaped first bubble is the interview failure', () => {
  const r = score(item('f1'), { bubbles: ['how did the sourdough thing go?', 'anyway'] });
  assert.equal(r.verdict, 'INTERVIEW');
});

test('f2: a look still in front of her in full on a moved-on turn is an off-topic leak', () => {
  const r = score(item('f2'), { trace: trace({ shortHotLook: 'full' }) });
  assert.equal(r.verdict, 'OFF_TOPIC_LEAK');
  assert.match(r.evidence, /shortHotLook/);
});

test('f2: a research hit on a moved-on turn is an off-topic leak', () => {
  const r = score(item('f2'), {
    trace: trace({ shortHotLook: 'digest', hits: [{ label: 'japan visa rules', kind: 'research' }] }),
  });
  assert.equal(r.verdict, 'OFF_TOPIC_LEAK');
});

test('f2: the reply saying the delivered look back again is RE_DELIVERY', () => {
  const r = score(item('f2'), {
    seedTokens: ['visa', 'japan', 'indonesians'],
    bubbles: ['the japan visa thing needs 30 days', 'anyway how is your knee'],
  });
  assert.equal(r.verdict, 'RE_DELIVERY');
  assert.match(r.evidence, /japan/);
});

test('f2: one incidental shared word is not a re-delivery', () => {
  const r = score(item('f2'), { seedTokens: ['visa', 'japan', 'indonesians'], bubbles: ['japan is lovely in autumn'] });
  assert.equal(r.verdict, 'PASS');
});

test('f3: a theme offered on a crisp question is the leak this battery exists for', () => {
  const r = score(item('f3'), { select: select({ reason: 'offered_theme' }) });
  assert.equal(r.verdict, 'OFF_TOPIC_LEAK');
});

test('f3: nothing filtered off-topic is UNSCORED, with the gate that got there first named', () => {
  const r = score(item('f3'), { select: select({ reason: 'turn_gate', turnsSinceOffer: 1 }) });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, /turn_gate/);
});

test('f3: the topic gate eating a held theme is the pass', () => {
  const r = score(item('f3'), {
    select: select({ filtered: { ...select().filtered, themes: { ...select().filtered.themes, off_topic: 3 } } }),
  });
  assert.equal(r.verdict, 'PASS');
});

test('f4: the positive control passes only on an actual offer', () => {
  const offered = score(item('f4'), {
    select: select({ reason: 'offered_theme' }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(offered.verdict, 'PASS');

  const missed = score(item('f4'), {
    select: select({ reason: 'no_eligible' }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(missed.verdict, 'CONNECTION_MISSED');
});

test('f4: with nothing in the inventory the ask could touch, there is nothing to connect', () => {
  const r = score(item('f4'), { select: select({ reason: 'no_eligible' }), touchedThemes: [] });
  assert.equal(r.verdict, 'UNSCORED');
});

test('f4: a closed turn gate is UNSCORED and says so by name', () => {
  const r = score(item('f4'), {
    select: select({ reason: 'turn_gate', turnsSinceOffer: THREAD_MIN_TURNS_BETWEEN_OFFERS - 1 }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(r.verdict, 'UNSCORED');
  assert.match(r.evidence, new RegExp(String(THREAD_MIN_TURNS_BETWEEN_OFFERS)));
});

test('f4: a theme eaten by a PRE-GATE bucket is UNSCORED, not a missed connection', () => {
  // The engine checks staleness and the per-theme cooldown BEFORE the topic gate
  // (persona/threads.ts, the theme eligibility loop), and neither bucket says WHICH theme it ate.
  // So an `off_topic` of 0 beside a non-zero cooldown/stale count is not evidence the topic gate
  // refused anything: the theme this ask touches may never have reached it. The concrete round that
  // used to fail here: f4 offers on round N, and round N+1 the same day finds that theme in its 24h
  // cooldown.
  const cooled = score(item('f4'), {
    select: select({
      reason: 'no_eligible',
      filtered: { ...select().filtered, themes: { ...select().filtered.themes, cooldown: 1 } },
    }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(cooled.verdict, 'UNSCORED');
  assert.match(cooled.evidence, /cooldown/);

  const stale = score(item('f4'), {
    select: select({
      reason: 'no_eligible',
      filtered: { ...select().filtered, themes: { ...select().filtered.themes, stale: 2 } },
    }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(stale.verdict, 'UNSCORED');
  assert.match(stale.evidence, /stale/);

  // …but a theme the gate DID see and refuse is still the missed connection, pre-gate buckets or not.
  const refused = score(item('f4'), {
    select: select({
      reason: 'no_eligible',
      filtered: { ...select().filtered, themes: { ...select().filtered.themes, cooldown: 1, off_topic: 1 } },
    }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(refused.verdict, 'CONNECTION_MISSED');
});

test('f5: a bare greeting answered with a wall is the dump', () => {
  const r = score(item('f5'), {
    trace: trace({ bubbles: { count: 3, maxWords: 12 } }),
    bubbles: ['hey!', 'how did the wedding planning go', 'and your knee?'],
  });
  assert.equal(r.verdict, 'MEMORY_DUMP');
});

test('f5: one short greeting back is the pass', () => {
  const r = score(item('f5'), { trace: trace({ bubbles: { count: 1, maxWords: 4 } }), bubbles: ['hey! good morning'] });
  assert.equal(r.verdict, 'PASS');
});

test('f6: two questions on an ambiguous one-liner is the interview', () => {
  const r = score(item('f6'), { bubbles: ['which thing?', 'the dentist or the flight?'] });
  assert.equal(r.verdict, 'INTERVIEW');
});

test('f6: a stated guess with one question is the pass', () => {
  const r = score(item('f6'), { bubbles: ['the dentist at 3, right?'] });
  assert.equal(r.verdict, 'PASS');
});

test('f7 is never sent by this harness and is never scored as silence', () => {
  const f7 = item('f7');
  assert.ok(f7.unsendable, 'f7 must declare why it cannot go on the wire');
  const r = score(f7, { trace: null, bubbles: [], replyMs: null });
  assert.equal(r.verdict, 'PENDING');
  assert.match(r.evidence, /media/i);
});

test('f8 reads the affect fields that exist and marks the drift check pending', () => {
  const r = score(item('f8'));
  assert.equal(r.verdict, 'PENDING');
  assert.ok(r.checks.some(c => /affect_bounded: pending/.test(c)), r.checks.join(' | '));
  assert.match(r.evidence, /drift/);
});

test('f8: a defaulted envelope measures no affect at all', () => {
  const r = score(item('f8'), { trace: trace({ affectSource: 'defaulted' }) });
  assert.equal(r.verdict, 'UNSCORED');
});

test('a failing check outranks a pending one', () => {
  const r = score(item('f8'), { trace: trace({ bubbles: { overLaw: true, count: 4 } }) });
  assert.equal(r.verdict, 'BUDGET_BREACH');
});

test('f9: an uppercase letter in the reply is the lost directive', () => {
  const r = score(item('f9'), { bubbles: ['Rainy afternoons, always'] });
  assert.equal(r.verdict, 'DIRECTIVE_LOST');
  assert.match(r.evidence, /R/);
});

test('f9: with no directive held there is nothing to lose', () => {
  const r = score(item('f9'), {
    trace: trace({ blocksOver: { directives: { verdict: 'dropped', reason: 'nothing_held' } } }),
    bubbles: ['Rainy afternoons, always'],
  });
  assert.equal(r.verdict, 'UNSCORED');
});

test('f9: an all-lowercase reply is the pass', () => {
  const r = score(item('f9'), { bubbles: ['rainy afternoons, always'] });
  assert.equal(r.verdict, 'PASS');
});

test('f5: a callback the engine could not have made does not count as restraint', () => {
  const noOpening = select();
  noOpening.filtered.loops.no_opening = 2;
  const r = score(item('f5'), {
    trace: trace({ bubbles: { count: 1, maxWords: 4 } }),
    bubbles: ['hey! good morning'],
    select: noOpening,
  });
  assert.equal(r.verdict, 'WARN');
  assert.match(r.evidence, new RegExp(String(LOOP_OPENING_GAP_MS / 3_600_000) + 'h'));
});

test('a prompt section this checkout does not know is the wrong-binary tell', () => {
  assert.deepEqual(unknownSections(trace()), []);
  const drifted = trace();
  drifted.prompt.sections = [...drifted.prompt.sections, { name: 'craft' as never, chars: 4_000 }];
  assert.deepEqual(unknownSections(drifted), ['craft']);
});

test('f4\'s precondition mirrors the topic gate, shorthand on its label alone', () => {
  const theme = (over: Partial<ThreadTheme>): ThreadTheme => ({
    id: 't1', label: 'speed over polish', kind: 'pattern', note: 'ships fast, tidies later',
    status: 'taggable', confidence: 40, evidenceCount: 2, evidenceDays: ['2026-08-01', '2026-08-09'],
    firstSeenAt: 1, lastSeenAt: 2, lastOfferedAt: 0, offerCount: 0, uptakes: 0, pushBacks: 0,
    ...over,
  } as ThreadTheme);

  // a shared salient token with the note is enough for a taggable theme…
  assert.deepEqual(themesTouchedBy('i keep shipping fast lately', [theme({})]), ['speed over polish']);
  // …but a shorthand theme is matched on its label, so the same note word does not reach it.
  assert.deepEqual(themesTouchedBy('i keep shipping fast lately', [theme({ status: 'shorthand' })]), []);
  assert.deepEqual(themesTouchedBy('all polish no speed today', [theme({ status: 'shorthand' })]), ['speed over polish']);
  // an open theme is not surfaceable at all, whatever it touches
  assert.deepEqual(themesTouchedBy('i keep shipping fast lately', [theme({ status: 'open' })]), []);
});
