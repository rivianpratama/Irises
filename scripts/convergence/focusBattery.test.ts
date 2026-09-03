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
  RECEIPT_SLOP_MS,
  attributeReceipts,
  mergeReceipts,
  scoreItem,
  themesTouchedBy,
  unknownSections,
  type FocusItem,
  type Receipt,
  type TurnEvidence,
} from './focusBattery.js';
import {
  DATA_BUDGET_KEYS,
  LOOP_OPENING_GAP_MS,
  PROSE_BUDGET_KEYS,
  PROMPT_BUDGET,
  MIN_TRANSCRIPT_SHARE,
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

/**
 * The sections a plain 1:1 turn reports, each a little UNDER its ceiling.
 *
 * Derived from `PROMPT_BUDGET` rather than copied from this month's measurements on purpose: the
 * ratchet exists to pull those ceilings DOWN in the later phases, and a fixture holding today's
 * numbers would then sit ABOVE them — failing "a healthy on-topic turn passes" and half the cases
 * below for a prose deletion that is the whole point of the phase. What these tests are about is the
 * SCORER, so the fixture says "inside its ceiling" and lets the ceiling be whatever it is.
 */
const UNDER_CEILING = 50;
function sections(
  over?: Partial<Record<BudgetKey, number>>,
  extra?: Partial<Record<BudgetKey, number>>,
): TurnTraceDetail['prompt']['sections'] {
  const present: BudgetKey[] = [
    'persona', 'status_contract', 'context_block', 'current_time', 'turn_focus',
    'behavior_anchor', 'json_anchor',
  ];
  const rows = present.map(name => ({
    name,
    chars: over?.[name] ?? Math.max(1, PROMPT_BUDGET[name] - UNDER_CEILING),
  }));
  // Sections a plain 1:1 turn does not carry at all — a burst, a group header, the ops in flight.
  for (const [name, chars] of Object.entries(extra ?? {})) rows.push({ name: name as BudgetKey, chars: chars as number });
  return rows as TurnTraceDetail['prompt']['sections'];
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
  /** Sections the plain fixture does not carry, added at whatever size the case needs. */
  sectionsExtra?: Partial<Record<BudgetKey, number>>;
  bubbles?: Partial<TurnTraceDetail['bubbles']>;
  shortHotLook?: TurnTraceDetail['gates']['memory']['shortHotLook'];
  hits?: TurnTraceDetail['gates']['memory']['hits'];
  blocksOver?: MemoryGateReports;
  /** The transcript's share of the context, for the branch that reads it against the floor. */
  transcriptShare?: number;
  affectSource?: TurnTraceDetail['affect']['source'];
  moodLevel?: number;
}

function trace(patch: TracePatch = {}): TurnTraceDetail {
  return {
    prompt: {
      sections: sections(patch.sectionsOver, patch.sectionsExtra),
      personaChars: 138_102,
      dynChars: 11_000,
      anchorChars: 2_908,
      systemChars: 152_600,
      messagesChars: 1_207,
      transcriptRows: 8,
      // Derived for the same reason the section sizes above are, and it is the harder half to see:
      // `MIN_TRANSCRIPT_SHARE` is ratcheted UP as the prose shrinks (promptPolicy.ts records
      // 0.0068 → 0.0070 through P2 part 3), so a literal measurement of today's share is a floor
      // waiting to overtake it — and a share under the floor makes `memory_ceiling` WARN, which
      // turns every `verdict === 'PASS'` case in this file (nine of them) red for a prose deletion
      // that is the point of the phase. A fifteenth over whatever the floor is, rounded so the
      // number a report prints stays readable.
      transcriptShare: patch.transcriptShare ?? Number((MIN_TRANSCRIPT_SHARE * 1.15).toFixed(4)),
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

test('no assistant row on a round that read receipts is SILENT', () => {
  // "whatever the receipts say" is what this said before the round-global guard below, and it is
  // now the opposite of the rule: a round that filed NO receipt anywhere reads as UNSCORED, not as
  // a silence. This case passes on the default evidence because that evidence carries
  // `receiptsUsable: true` — which is the clause the title has to name.
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

test('a round that measured nothing at all is UNSCORED, not eight silences', () => {
  // A dead or misconfigured instance answers nothing AND files nothing. Reading that as SILENT ×8
  // exits 1 under a FAILURE headline, which is exactly the confusion the third exit code exists to
  // prevent: "the code is wrong" and "nothing was measured" want opposite responses.
  const r = score(item('f1'), { bubbles: [], replyMs: null, receiptsUsable: false, trace: null, select: null });
  assert.equal(r.verdict, 'UNSCORED');
  // …but a real message answered with nothing, on a round that DID read receipts, is still SILENT.
  assert.equal(score(item('f1'), { bubbles: [], replyMs: null }).verdict, 'SILENT');
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

test('every data section is weighed by name, not just the dossier', () => {
  // expectations.ts promises that a DATA key's overshoot is "REPORTED with the number and never
  // failed". It was only half true: context_block was the one key any check looked at, so a burst
  // or a tapped reply over its ceiling appeared in no check line and no cell.
  const r = score(item('f1'), { trace: trace({ sectionsExtra: { burst: PROMPT_BUDGET.burst * 2 } }) });
  assert.notEqual(r.verdict, 'BUDGET_BREACH');
  const line = r.checks.find(c => c.startsWith('memory_ceiling:'));
  assert.ok(line, r.checks.join(' | '));
  assert.match(line, /warn/);
  assert.match(line, new RegExp(`burst ${PROMPT_BUDGET.burst * 2}`));
  assert.match(line, new RegExp(String(PROMPT_BUDGET.burst)));

  // …and on a clean turn the check says which data sections it weighed, with their ceilings, so a
  // reader can see that a section was READ rather than skipped.
  const clean = score(item('f1'), { trace: trace({ sectionsExtra: { burst: 100, tapped_reply: 200 } }) });
  const cleanLine = clean.checks.find(c => c.startsWith('memory_ceiling:'));
  assert.ok(cleanLine, clean.checks.join(' | '));
  assert.match(cleanLine, /memory_ceiling: pass/);
  for (const k of ['context_block', 'burst', 'tapped_reply']) assert.match(cleanLine, new RegExp(k));
});

test("the plain fixture's transcript share stays over whatever the floor is", () => {
  // The assertion that keeps the derivation above honest. Re-literalise that share and this still
  // passes today — but `MIN_TRANSCRIPT_SHARE` only ever moves UP, and the day it passes the literal
  // this is the one line that says why nine PASS cases went WARN together.
  assert.ok(
    trace().prompt.transcriptShare > MIN_TRANSCRIPT_SHARE,
    `the fixture's share (${trace().prompt.transcriptShare}) is under the ${MIN_TRANSCRIPT_SHARE} floor — `
    + 'memory_ceiling now warns on the plain turn and every PASS case in this file is red for a reason '
    + 'that has nothing to do with the scorer',
  );
  const line = score(item('f1')).checks.find(c => c.startsWith('memory_ceiling:'));
  assert.match(line ?? '', /memory_ceiling: pass/);
});

test('a memory_ceiling warn still prints the share reading its pass line prints', () => {
  // The two things this check reports are the section sizes and the transcript's share of the
  // context, and the warn line carried only the first: an overshoot in a data section HID the share
  // reading, which is the one number a reader of an oversized prompt most wants. Both branches say
  // both things now.
  const over = score(item('f1'), { trace: trace({ sectionsExtra: { burst: PROMPT_BUDGET.burst * 2 } }) });
  const overLine = over.checks.find(c => c.startsWith('memory_ceiling:')) ?? '';
  assert.match(overLine, /warn/);
  assert.match(overLine, /transcript share/);
  assert.match(overLine, /system \d+ chars over \d+ rows/);

  // The other way this check warns: the share itself under the floor. Named as its own reason AND
  // still carrying the full reading.
  const under = score(item('f1'), { trace: trace({ transcriptShare: MIN_TRANSCRIPT_SHARE / 2 }) });
  const underLine = under.checks.find(c => c.startsWith('memory_ceiling:')) ?? '';
  assert.match(underLine, /warn/);
  assert.match(underLine, new RegExp(`below the ${MIN_TRANSCRIPT_SHARE} floor`));
  assert.match(underLine, /system \d+ chars over \d+ rows/);
  // A share under the floor is reported, never failed — the prompt being prose-heavy is the phase's
  // subject, not this turn's defect.
  assert.notEqual(under.verdict, 'MEMORY_DUMP');
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
  // …and it says how far the pass reaches: the receipt names no winner, so an offer of some OTHER
  // theme (one minted mid-round, or any theme at all with the topic gate off) reads the same here.
  assert.match(offered.evidence, /does not name/);

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
  // So a non-zero cooldown/stale count is not evidence the topic gate refused anything: the theme
  // this ask touches may never have reached it. The concrete round that used to fail here: f4 offers
  // on round N, and round N+1 the same day finds that theme in its 24h cooldown.
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

  // A pre-gate bucket beside an off_topic count is the NORMAL shape of a second round of the day on
  // the warm inventory f3 and f4 need: the unrelated themes go off_topic on every turn, and the
  // touched one sits in the cooldown that f4's own previous PASS billed. `off_topic ≥ 1` says
  // nothing about WHICH theme reached the gate, so it cannot be what turns this into a failure.
  const cooledAmongOthers = score(item('f4'), {
    select: select({
      reason: 'no_eligible',
      filtered: { ...select().filtered, themes: { ...select().filtered.themes, cooldown: 1, off_topic: 1 } },
    }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(cooledAmongOthers.verdict, 'UNSCORED');
  assert.match(cooledAmongOthers.evidence, /cooldown/);
});

test('f4: nothing filtered before the gate, and still no offer, IS the missed connection', () => {
  // The other side of the branch above, and the reason it is a branch rather than a blanket
  // pass: with `stale` and `cooldown` both 0, every theme in the row DID reach the topic gate, so a
  // theme this ask touches going unoffered is the engine failing to connect — which is the whole
  // point of the positive control. off_topic ≥ 1 here says the gate refused things; the touched
  // theme was among what it saw.
  const missed = score(item('f4'), {
    select: select({
      reason: 'no_eligible',
      filtered: { ...select().filtered, themes: { ...select().filtered.themes, off_topic: 3 } },
    }),
    touchedThemes: ['speed over polish'],
  });
  assert.equal(missed.verdict, 'CONNECTION_MISSED');
  assert.match(missed.evidence, /speed over polish/);
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

// -- the pure half of the live path --------------------------------------------------------------
// Everything above scores ONE turn's evidence from a fixture. These two functions are what BUILDS
// that evidence out of a round's receipts, and until now nothing exercised them: not a test (they
// were private) and not a run (no round has been executed against an instance). They are pure, so
// there was no reason for that beyond their sitting inside the network path. They no longer do.

const TRACE = 'turn:trace';
const SELECT = 'threads:select';
const rc = (chatId: string, label: string, ts: number, detail: Record<string, unknown> | null = { n: ts }): Receipt =>
  ({ chatId, label, ts, detail });

test('a receipt read from both stores is one receipt, and the merge comes back in time order', () => {
  const durable = [rc('c1', TRACE, 300), rc('c1', TRACE, 100)];
  // The ring's whole reason for being read: the tail of the round, which the debounced history write
  // has not persisted yet. The overlap with the durable read is the same receipt twice.
  const ring = [rc('c1', TRACE, 300), rc('c1', TRACE, 500)];
  const merged = mergeReceipts(durable, ring);
  assert.deepEqual(merged.map(r => r.ts), [100, 300, 500]);
});

test('the merge keys on the chat and the label, not on the timestamp alone', () => {
  // Two chats filing in the same millisecond is rare on a 20 s stagger -- but `threads:select` and
  // `turn:trace` for ONE turn share a millisecond often, and collapsing those would silently drop
  // one of the two receipts every item is scored on.
  const merged = mergeReceipts([rc('c1', TRACE, 100), rc('c2', TRACE, 100), rc('c1', SELECT, 100)]);
  assert.equal(merged.length, 3);
});

test("a receipt from another chat is never attributed to this item's turn", () => {
  const receipts = [rc('c1', TRACE, 1_000), rc('c2', TRACE, 1_000)];
  assert.equal(attributeReceipts(receipts, 'c1', TRACE, 1_000).probe?.detail?.n, 1_000);
  assert.equal(attributeReceipts(receipts, 'c3', TRACE, 1_000).probe, undefined);
});

test('the probe takes the FIRST receipt at or after its send, and nothing from before it', () => {
  const receipts = mergeReceipts([
    rc('c1', TRACE, 5_000),   // an earlier turn in the same chat -- before the window
    rc('c1', TRACE, 10_500),  // the probe's own
    rc('c1', TRACE, 12_000),  // whatever came after
  ]);
  assert.equal(attributeReceipts(receipts, 'c1', TRACE, 10_000).probe?.ts, 10_500);
});

test('a receipt filed just BEFORE the send still belongs to it', () => {
  // The send stamp is taken before curl unwinds, and a reply can be persisted before the 202 does,
  // so the window opens a slop earlier on purpose. One millisecond outside it is outside.
  assert.equal(attributeReceipts([rc('c1', TRACE, 9_999)], 'c1', TRACE, 10_000).probe?.ts, 9_999);
  assert.equal(
    attributeReceipts([rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS)], 'c1', TRACE, 10_000).probe?.ts,
    10_000 - RECEIPT_SLOP_MS,
  );
  assert.equal(attributeReceipts([rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS - 1)], 'c1', TRACE, 10_000).probe, undefined);
});

test("each seed's window closes at the next send, so a seed's receipt is not read as the probe's", () => {
  // f2 is the item this decides: a look delivered on the seed turn files its own turn:trace, and
  // reading THAT as the probe's would score the topic switch against the wrong prompt entirely.
  // The stamps are a round's real shape -- a seed, a FOCUS_SEED_GAP_MS-ish gap, another seed,
  // another gap, the probe -- because the gaps are what hold the windows apart (see below).
  const seedOne = 1_000_000;
  const seedTwo = seedOne + 120_000;
  const probe = seedTwo + 120_000;
  const receipts = mergeReceipts([
    rc('c1', TRACE, seedOne + 4_100, { turn: 'seed one' }),
    rc('c1', TRACE, seedTwo + 3_800, { turn: 'seed two' }),
    rc('c1', TRACE, probe + 4_200, { turn: 'the probe' }),
  ]);
  const got = attributeReceipts(receipts, 'c1', TRACE, probe, [seedOne, seedTwo]);
  assert.equal(got.probe?.detail?.turn, 'the probe');
  assert.deepEqual(got.seeds.map(r => r?.detail?.turn), ['seed one', 'seed two']);
});

test("the last seed's window and the probe's overlap by exactly the slop, and nothing wider", () => {
  // Both windows open a slop before their own send, so a receipt in that one-second band is read as
  // BOTH the last seed's and the probe's. That is the documented cost of opening the probe's window
  // early, and what makes it harmless is the seed gap: the shortest a round uses is 120 s
  // (FOCUS_SEED_GAP_MS), so a seed's receipt can only land in the band if the seed turn took its
  // whole gap minus a second to file. Pinned so the day someone shortens a gap toward the slop --
  // or widens the slop toward a gap -- this says what starts going wrong.
  const inBand = attributeReceipts(
    [rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS, { turn: 'ambiguous' })],
    'c1', TRACE, 10_000, [5_000],
  );
  assert.equal(inBand.probe?.detail?.turn, 'ambiguous');
  assert.equal(inBand.seeds[0]?.detail?.turn, 'ambiguous');
  // One millisecond earlier and it is the seed's alone.
  const before = attributeReceipts(
    [rc('c1', TRACE, 10_000 - RECEIPT_SLOP_MS - 1, { turn: 'the seed' })],
    'c1', TRACE, 10_000, [5_000],
  );
  assert.equal(before.probe, undefined);
  assert.equal(before.seeds[0]?.detail?.turn, 'the seed');
});

test('a seed that filed nothing leaves a hole rather than borrowing its neighbour', () => {
  const receipts = [rc('c1', TRACE, 122_000, { turn: 'seed two' })];
  const got = attributeReceipts(receipts, 'c1', TRACE, 240_000, [1_000, 121_000]);
  assert.deepEqual(got.seeds.map(r => r?.detail?.turn), [undefined, 'seed two']);
});

test('attribution reads one label at a time', () => {
  const receipts = mergeReceipts([rc('c1', SELECT, 10_100), rc('c1', TRACE, 10_200)]);
  assert.equal(attributeReceipts(receipts, 'c1', TRACE, 10_000).probe?.ts, 10_200);
  assert.equal(attributeReceipts(receipts, 'c1', SELECT, 10_000).probe?.ts, 10_100);
});
