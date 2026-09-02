// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The affect integrator is charter §10.1 applied to the per-turn gauges, the same way climate.ts
// applies it to the weeks-scale dials: the model contributes a DIRECTION (`mood_shift`) and a
// feeling WORD, and every bound that makes that safe — the step sizes, the floors and ceilings, the
// valence band, the per-turn cap, the rolling budgets — is arithmetic in affectDrift.ts. These
// tests mirror climate.test.ts item for item, and add the one property climate has no analog for:
// clock-target monotonicity, which is what catches a sign error in a coefficient.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOOD_CORES, WILLCOX_WHEEL, EXTENDED_WORDS, wheelWords, feelingWords,
  normalizeMoodLabel, coreForLabel, CORE_VALENCE_BAND,
} from './mood.js';
import {
  GAUGE_SPECS, MOOD_SHIFTS, MOOD_TARGET_PULL, BROKE_STEP_MULTIPLIER, EPISTEMIC_STEP_WIDENING,
  AFFECT_TURN_CAP, AFFECT_MOOD_WINDOW_CAP, AFFECT_MOOD_WINDOW_MS, AFFECT_BROKE_WINDOW_MS,
  AFFECT_MOVES_CAP, defaultAffectGauges, affectTargets, applyAffectDrift,
  type AffectGauges, type AffectInput, type AffectMove, type MoodShift,
} from './affectDrift.js';
import type { ComputedState } from './status.js';

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 60 * 60 * 1000;

const MOOD = GAUGE_SPECS.find(s => s.key === 'mood_level')!;

/** A clock state with the only two fields this engine reads. */
function clock(load: number, energy: number): ComputedState {
  return {
    cycle: { phase: 'luteal', day: 20, load, description: 'fixture' },
    circadian: { slot: 'evening', hour: 19, weekend: false, energy, description: 'fixture' },
  };
}

// Four fixture clocks — a plain day, her best window, a late-luteal dead-night, and a rested one.
// The energies are picked so each one's MOOD target lands on a whole number: mood is what the
// hand-computed steps below are built around, and a target sitting exactly on .5 would make those
// expected values depend on a rounding tie-break rather than on the coefficients.
const NEUTRAL = clock(40, 50);
const PEAK = clock(25, 92);
const HARD = clock(85, 32);
const RESTED = clock(10, 90);

function shift(moodShift: MoodShift, moodLabel: string): AffectInput {
  return { moodShift, moodLabel, epistemic: 'none' };
}

/** Every clock-driven gauge already ON its target, so only the overridden ones want to move —
 *  which is what makes an assertion about one gauge an assertion about that gauge's own rule
 *  rather than about how much of the shared turn cap the others left behind. */
function settled(c: ComputedState, overrides: Partial<AffectGauges> = {}): AffectGauges {
  return { ...affectTargets(c), rapport: 40, ...overrides };
}

function totalMovement(a: AffectGauges, b: AffectGauges): number {
  return GAUGE_SPECS.reduce((sum, s) => sum + Math.abs(b[s.key] - a[s.key]), 0);
}

/** What the engine itself booked against the turn cap — the ledger rows it wrote for this turn. */
function spentThisTurn(moves: readonly AffectMove[], now: number): number {
  return moves.filter(m => m.at === now).reduce((sum, m) => sum + Math.abs(m.d), 0);
}

// ── coreForLabel: the inverse of the wheel ───────────────────────────────────

// `normalizeMoodLabel` already accepts any wheel word under any core, which is exactly what makes
// the core DERIVABLE from the word — so the model stops reporting a (core, label) pair it can
// contradict itself with, and `mood_core` becomes code's answer instead of a second judgment call.
test('coreForLabel round-trips every canonical wheel word back to its own core', () => {
  for (const core of MOOD_CORES) {
    for (const word of wheelWords(core)) {
      assert.equal(coreForLabel(word), core, `${word} should file under ${core}`);
    }
  }
  // 72 words, so this is the whole chart and not a sample of it.
  assert.equal(MOOD_CORES.flatMap(wheelWords).length, 72);
});

test('coreForLabel is case- and whitespace-tolerant, and takes the extra shades too', () => {
  assert.equal(coreForLabel('MISERABLE'), 'sad');
  assert.equal(coreForLabel('  serene  '), 'peaceful');
  assert.equal(coreForLabel('overwhelmed'), 'scared'); // an Irises extra, not on Willcox's chart
  assert.equal(coreForLabel('tender'), 'peaceful');
  assert.equal(coreForLabel('drained'), 'sad');
  assert.equal(coreForLabel('curious'), 'joyful');
});

// 'cheerful' is the one word that appears twice in the vocabulary: it is a canonical Willcox
// tertiary under `powerful` AND one of Irises's extra shades under `joyful`. The canonical chart
// wins, deliberately — otherwise the round-trip above would fail for a real wheel word, and the
// two nearly-identical bands ([65,95] vs [70,100]) make the choice nearly free either way.
test('a word in both the wheel and the extras files under its CANONICAL core', () => {
  assert.ok(WILLCOX_WHEEL.powerful.tertiary.includes('cheerful'));
  assert.ok(EXTENDED_WORDS.joyful.includes('cheerful'));
  assert.equal(coreForLabel('cheerful'), 'powerful');
});

test('an unrecognized word falls back to peaceful — the same fallback the prompt already had', () => {
  assert.equal(coreForLabel('zzzqqq'), 'peaceful');
  assert.equal(coreForLabel(''), 'peaceful');
  assert.equal(coreForLabel('   '), 'peaceful');
  // Hostile non-strings cannot throw: this runs on a label that came off a model envelope.
  assert.equal(coreForLabel(undefined as unknown as string), 'peaceful');
  assert.equal(coreForLabel(null as unknown as string), 'peaceful');
  assert.equal(coreForLabel(42 as unknown as string), 'peaceful');
});

// The pair that makes the derivation total: whatever `normalizeMoodLabel` lets through,
// `coreForLabel` can name a core for. No label can reach the band clamp without a band.
test('every label normalizeMoodLabel accepts has a core, and every core has a band', () => {
  for (const core of MOOD_CORES) {
    for (const word of feelingWords(core)) {
      const kept = normalizeMoodLabel(core, word);
      assert.equal(kept, word, 'a recognized word survives normalization');
      const band = CORE_VALENCE_BAND[coreForLabel(kept)];
      assert.ok(band && band[0] < band[1], `${word} has no usable band`);
    }
  }
});

// ── the gauge table ──────────────────────────────────────────────────────────

test('the gauge table mirrors DIALS: 1-100 bounds, a default inside them, asymmetric steps', () => {
  assert.deepEqual(
    GAUGE_SPECS.map(s => s.key),
    ['mood_level', 'anxiety', 'warmth', 'social_battery', 'patience', 'rapport'],
    'order is load-bearing — the turn cap truncates in exactly this order',
  );
  for (const spec of GAUGE_SPECS) {
    assert.equal(spec.floor, 1, `${spec.key} floor`);
    assert.equal(spec.ceiling, 100, `${spec.key} ceiling`);
    assert.ok(spec.floor <= spec.dflt && spec.dflt <= spec.ceiling, `${spec.key} default outside its band`);
    assert.ok(spec.up >= 1 && spec.down >= 1, `${spec.key} has a zero step`);
  }
  // The three deleted envelope gauges are gone, not quietly kept: the field-set shrink is the point.
  for (const dead of ['conviction', 'engagement', 'profile_note']) {
    assert.ok(!GAUGE_SPECS.some(s => (s.key as string) === dead), `${dead} should not be a gauge`);
  }
  assert.deepEqual(MOOD_SHIFTS, ['lifted', 'steady', 'dipped', 'broke']);
});

test('a cold start is every gauge at its own default — never 0', () => {
  const d = defaultAffectGauges();
  for (const spec of GAUGE_SPECS) assert.equal(d[spec.key], spec.dflt, spec.key);
  assert.equal(d.rapport, 40, 'rapport starts below the midpoint — closeness is earned');
  assert.equal(d.mood_level, 50);
  assert.equal(Object.keys(d).length, GAUGE_SPECS.length, 'closed shape');
});

// A stored row from before this engine existed is missing gauges it never had, and may carry a
// garbled value in one it did. Each such gauge seeds from its DEFAULT — never from 0, which as a
// 1-100 gauge would read as total collapse rather than as "unknown".
test('a missing or garbled gauge seeds from its default rather than corrupting the turn', () => {
  const legacy = { mood_level: 'very high', warmth: undefined } as unknown as AffectGauges;
  const r = applyAffectDrift(legacy, shift('steady', 'content'), NEUTRAL, [], T0);
  for (const spec of GAUGE_SPECS) {
    assert.ok(Number.isFinite(r.next[spec.key]), `${spec.key} came back non-finite`);
    assert.ok(r.next[spec.key] >= 1 && r.next[spec.key] <= 100, `${spec.key} out of range`);
  }
  assert.equal(r.next.rapport, 40, 'an absent gauge is its default, not 0');
});

// Every coefficient, pinned at four points — and the one place a coefficient change is meant to
// fail first, before it surfaces as a confusing off-by-three in a step test further down.
test('the clock targets are what the fixtures below assume', () => {
  assert.deepEqual(affectTargets(NEUTRAL), { mood_level: 55, anxiety: 53, warmth: 60, social_battery: 45, patience: 61 });
  assert.deepEqual(affectTargets(PEAK), { mood_level: 70, anxiety: 36, warmth: 76, social_battery: 78, patience: 73 });
  assert.deepEqual(affectTargets(HARD), { mood_level: 37, anxiety: 78, warmth: 46, social_battery: 21, patience: 43 });
  assert.deepEqual(affectTargets(RESTED), { mood_level: 74, anxiety: 30, warmth: 78, social_battery: 81, patience: 78 });

  // Rapport has no clock target: nothing about the hour or the cycle day is evidence about how
  // close these two are, so it is the one gauge the clock cannot touch.
  assert.ok(!('rapport' in affectTargets(NEUTRAL)));
  // And a target is always a usable gauge value, however extreme the clock gets.
  for (const c of [clock(1, 1), clock(100, 100), clock(1, 100), clock(100, 1)]) {
    for (const v of Object.values(affectTargets(c))) {
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 100, `target ${v} out of range`);
    }
  }
});

// ── the mood step: a direction and nothing else ──────────────────────────────

// `mood_shift` is the affect analog of climate's `signOf`: the model says which way, and the step
// size, the band and the budgets are all decided here. PEAK puts mood_target at 70 so a lift from
// 64 (and a dip from 78) lands exactly ON the target, leaving the ≤2 pull at zero — which is what
// makes "exactly `up`, never more" a statement about the step and not about the pull.
test('a lift buys exactly the up step, a dip exactly the down step, steady nothing', () => {
  assert.equal(affectTargets(PEAK).mood_level, 70, 'the fixture the exact steps below depend on');

  const lifted = applyAffectDrift(settled(PEAK, { mood_level: 64 }), shift('lifted', 'content'), PEAK, [], T0);
  assert.equal(lifted.next.mood_level, 70, '64 + up(6), pull zero at the target');
  assert.deepEqual(lifted.report.changed, ['mood_level']);
  assert.deepEqual(lifted.report.shortened, []);

  const dipped = applyAffectDrift(settled(PEAK, { mood_level: 78 }), shift('dipped', 'content'), PEAK, [], T0);
  assert.equal(dipped.next.mood_level, 70, '78 - down(8) — a dip is cheaper than a lift');
  assert.ok(MOOD.down > MOOD.up, 'the asymmetry is the point: she falls further than she climbs');

  const still = applyAffectDrift(settled(PEAK, { mood_level: 70 }), shift('steady', 'content'), PEAK, [], T0);
  assert.equal(still.next.mood_level, 70);
  assert.deepEqual(still.report.changed, [], 'a settled turn moves nothing at all');
  assert.deepEqual(still.moves, [], 'and writes nothing to the ledger');
});

test('an off-enum shift is read as steady, not as a step', () => {
  const garbled = applyAffectDrift(
    settled(PEAK, { mood_level: 70 }),
    { moodShift: 'ECSTATIC' as unknown as MoodShift, moodLabel: 'content', epistemic: 'none' },
    PEAK, [], T0,
  );
  assert.deepEqual(garbled.report.changed, []);
  assert.equal(garbled.next.mood_level, 70);
});

// The pull is the clock's only claim on mood, and it is deliberately tiny: two points a turn, so
// the model's read of the moment always outweighs the simulation underneath it.
test('mood is pulled at most MOOD_TARGET_PULL points toward the clock target each turn', () => {
  assert.equal(MOOD_TARGET_PULL, 2);
  const r = applyAffectDrift(settled(PEAK, { mood_level: 60 }), shift('steady', 'content'), PEAK, [], T0);
  assert.equal(r.next.mood_level, 62, '60 → 62, not 60 → 70');

  // Below the target it pulls up, above it pulls down, and it never overshoots.
  const above = applyAffectDrift(settled(PEAK, { mood_level: 80 }), shift('steady', 'content'), PEAK, [], T0);
  assert.equal(above.next.mood_level, 78);
  const near = applyAffectDrift(settled(PEAK, { mood_level: 71 }), shift('steady', 'content'), PEAK, [], T0);
  assert.equal(near.next.mood_level, 70, 'one point away, so one point moves');
});

// ── the valence band is now a CLAMP ──────────────────────────────────────────

// mood.ts called CORE_VALENCE_BAND "guidance, not a clamp". It is a clamp here: the word she
// reports decides the floor and ceiling her level may sit between this turn, so "delighted at 12"
// and "miserable at 90" stop being expressible states.
test("the reported word's valence band bounds the level — a lift at the band ceiling is atBound", () => {
  const joyful = CORE_VALENCE_BAND[coreForLabel('delightful')];
  const r = applyAffectDrift(settled(PEAK, { mood_level: joyful[1] }), shift('lifted', 'delightful'), PEAK, [], T0);
  assert.deepEqual(r.report.atBound, ['mood_level']);
  assert.deepEqual(r.report.changed, []);
  assert.deepEqual(r.report.capped, []);
  assert.equal(r.next.mood_level, joyful[1], 'and it did not move');
  assert.deepEqual(r.moves, [], 'a step that never happened is not in the ledger');

  // The floor is the same story downward, and a bound only swallows the step pointed AT it.
  const sad = CORE_VALENCE_BAND[coreForLabel('miserable')];
  const floored = applyAffectDrift(settled(PEAK, { mood_level: sad[0] }), shift('dipped', 'miserable'), PEAK, [], T0);
  assert.deepEqual(floored.report.atBound, ['mood_level']);
  const away = applyAffectDrift(settled(PEAK, { mood_level: joyful[1] }), shift('dipped', 'delightful'), PEAK, [], T0);
  assert.deepEqual(away.report.atBound, []);
  assert.deepEqual(away.report.changed, ['mood_level']);
});

test('a level stored outside the band comes back INSIDE it, as a coercion rather than a step', () => {
  const [lo] = CORE_VALENCE_BAND[coreForLabel('delightful')];
  const up = applyAffectDrift(settled(PEAK, { mood_level: 30 }), shift('steady', 'delightful'), PEAK, [], T0);
  assert.equal(up.next.mood_level, lo, 'a delighted 30 is not a state she can be in');
  assert.deepEqual(up.report.changed, [], 'snapping into the band is a coercion, not a step she took');
  assert.deepEqual(up.moves, [], 'and it spends none of the turn budget');

  const down = applyAffectDrift(settled(PEAK, { mood_level: 99 }), shift('steady', 'miserable'), PEAK, [], T0);
  assert.equal(down.next.mood_level, CORE_VALENCE_BAND[coreForLabel('miserable')][1]);
});

// ── the per-turn cap, truncating in spec order ───────────────────────────────

// AFFECT_TURN_CAP is the answer to "how much can one message change her": 18 points of total
// movement, handed out in GAUGE_SPECS order, so mood gets first claim and rapport gets what's left.
test('AFFECT_TURN_CAP truncates in spec order, and capped/shortened stay disjoint', () => {
  const before: AffectGauges = {
    mood_level: 64, anxiety: 28, warmth: 75, social_battery: 60, patience: 60, rapport: 40,
  };
  const r = applyAffectDrift(before, shift('lifted', 'content'), PEAK, [], T0);

  // Wanted, in order: mood +6 (6 spent), anxiety +8 (14), warmth +1 (15), battery +5 → only 3
  // left, patience +5 → nothing left. Rapport asked for nothing (no thread outcome).
  assert.equal(r.next.mood_level, 70);
  assert.equal(r.next.anxiety, 36);
  assert.equal(r.next.warmth, 76);
  assert.equal(r.next.social_battery, 63, 'truncated to the 3 points still in the budget');
  assert.equal(r.next.patience, 60, 'the budget was gone by the time the order reached it');
  assert.equal(r.next.rapport, 40);

  assert.deepEqual(r.report.changed, ['mood_level', 'anxiety', 'warmth', 'social_battery']);
  assert.deepEqual(r.report.capped, ['patience']);
  assert.deepEqual(r.report.shortened, ['social_battery']);
  assert.deepEqual(r.report.atBound, []);
  assert.equal(totalMovement(before, r.next), AFFECT_TURN_CAP, 'spent to the point, not past it');
  assert.equal(spentThisTurn(r.moves, T0), AFFECT_TURN_CAP, 'and the ledger agrees with the gauges');

  // A gauge the budget merely shortened still MOVED, so it belongs in `changed` too; a capped one
  // did not, and the two can never be the same gauge.
  for (const k of r.report.shortened) assert.ok(r.report.changed.includes(k), `${k} shortened but not changed`);
  for (const k of r.report.capped) assert.ok(!r.report.shortened.includes(k), `${k} both capped and shortened`);
  assert.equal(r.moves.length, r.report.changed.length, 'one ledger row per gauge that moved');
});

// ── the rolling one-hour mood budget ────────────────────────────────────────

test('mood may move at most AFFECT_MOOD_WINDOW_CAP points inside a rolling hour', () => {
  const first = applyAffectDrift(settled(PEAK, { mood_level: 55 }), shift('lifted', 'content'), PEAK, [], T0);
  assert.equal(first.next.mood_level, 63, '55 + up(6) + pull(2)');

  // Twelve lifts a minute apart: the hour's budget runs out and stays out.
  let g = settled(PEAK, { mood_level: 55 });
  let ledger: AffectMove[] = [];
  let now = T0;
  let spent = 0;
  let capped = 0;
  for (let i = 0; i < 12; i++) {
    now += 60_000;
    const r = applyAffectDrift(g, shift('lifted', 'content'), PEAK, ledger, now);
    spent += Math.abs(r.next.mood_level - g.mood_level);
    if (r.report.capped.includes('mood_level')) capped++;
    g = r.next;
    ledger = r.moves;
  }
  assert.equal(spent, AFFECT_MOOD_WINDOW_CAP, 'the hour bought exactly its budget and no more');
  assert.ok(capped > 0, 'and the refusals were reported, not silent');

  // Past the window the early moves age out, so mood can move again.
  const later = now + AFFECT_MOOD_WINDOW_MS + 60_000;
  const r = applyAffectDrift(g, shift('lifted', 'content'), PEAK, ledger, later);
  assert.deepEqual(r.report.changed, ['mood_level']);
  assert.equal(r.moves[r.moves.length - 1].at, later, 'the ledger grows newest-last');
});

// ── 'broke': a 3x step, once per six hours ──────────────────────────────────

test("'broke' unlocks a 3x step — big enough that it takes the whole turn's budget", () => {
  assert.equal(BROKE_STEP_MULTIPLIER, 3);
  const before: AffectGauges = {
    mood_level: 90, anxiety: 50, warmth: 50, social_battery: 50, patience: 50, rapport: 40,
  };
  const r = applyAffectDrift(before, { ...shift('broke', 'delightful'), threadOutcome: 'pushed_back' }, HARD, [], T0);

  // 3 × down(8) = 24, clipped to -20 by the joyful floor and then to -18 by the turn cap.
  assert.equal(r.next.mood_level, 72);
  assert.deepEqual(r.report.changed, ['mood_level']);
  assert.deepEqual(r.report.shortened, ['mood_level']);
  assert.deepEqual(r.report.capped, ['anxiety', 'warmth', 'social_battery', 'patience', 'rapport'],
    'a break is the only thing that happened this turn');
  assert.equal(totalMovement(before, r.next), AFFECT_TURN_CAP);
  assert.ok(r.moves.some(m => m.k === 'mood_level' && m.broke === true), 'the break is on the ledger');
});

// The once-per-6h budget is what stops "i broke" from being a repeatable 18-point lever: the
// second one inside the window is downgraded to an ordinary dip, and the downgrade is REPORTED,
// because a 3x step that silently became a 1x step is indistinguishable from the model having
// changed its mind.
test("a second 'broke' inside six hours is treated as a dip, and says so in `shortened`", () => {
  const recent: AffectMove[] = [{ at: T0 - 2 * HOUR, k: 'mood_level', d: -18, broke: true }];
  const g = settled(PEAK, { mood_level: 45 });

  const second = applyAffectDrift(g, shift('broke', 'irritated'), PEAK, recent, T0);
  const plainDip = applyAffectDrift(g, shift('dipped', 'irritated'), PEAK, recent, T0);
  assert.equal(second.next.mood_level, plainDip.next.mood_level, 'it bought a dip, nothing more');
  assert.equal(second.next.mood_level, 39, '45 - down(8) + pull(2)');
  assert.deepEqual(second.report.shortened, ['mood_level'], 'the downgrade is on the receipt');
  assert.deepEqual(plainDip.report.shortened, [], 'an honest dip was not shortened by anything');
  assert.ok(!second.moves.some(m => m.at === T0 && m.broke),
    'a downgraded break does not claim the next six hours (the earlier one is still on the ledger)');

  // Once the window clears, the 3x step is available again.
  const aged: AffectMove[] = [{ at: T0 - AFFECT_BROKE_WINDOW_MS - 1000, k: 'mood_level', d: -18, broke: true }];
  const third = applyAffectDrift(g, shift('broke', 'irritated'), PEAK, aged, T0);
  assert.ok(Math.abs(third.next.mood_level - 45) > Math.abs(plainDip.next.mood_level - 45),
    'the break moved further than a dip would have');
  assert.deepEqual(third.moves.map(m => m.at), [T0], 'and the aged-out break was pruned');
});

// The allowance is spent by a break that LANDED, not by one that was asked for: if the hour's mood
// budget was already gone, the break bought nothing, and charging it six hours would be charging
// her for a step she never got.
test('a break the budget refused outright does not spend the next six hours', () => {
  const usedUpHour: AffectMove[] = [{ at: T0 - 60_000, k: 'mood_level', d: -AFFECT_MOOD_WINDOW_CAP }];
  const g = settled(PEAK, { mood_level: 45 });
  const refused = applyAffectDrift(g, shift('broke', 'irritated'), PEAK, usedUpHour, T0);
  assert.deepEqual(refused.report.capped, ['mood_level'], 'the hour had nothing left to give');
  assert.deepEqual(refused.report.changed, []);
  assert.ok(refused.moves.every(m => !m.broke), 'and nothing claimed the window');

  // So once the hour rolls, the 3x step is still there to be had.
  const later = T0 + AFFECT_MOOD_WINDOW_MS + 60_000;
  const r = applyAffectDrift(g, shift('broke', 'irritated'), PEAK, refused.moves, later);
  assert.ok(r.moves.some(m => m.at === later && m.broke === true));
  assert.equal(Math.abs(r.next.mood_level - 45), AFFECT_TURN_CAP, 'a full break, taking the whole turn');
});

// ── epistemic_trigger: information may move her further than pressure ────────

test('logic_valid / knowledge_gap widen the mood step by half; pressure buys the plain step', () => {
  assert.equal(EPISTEMIC_STEP_WIDENING, 1.5);
  const g = settled(RESTED, { mood_level: 60 });
  const plain = applyAffectDrift(g, shift('lifted', 'content'), RESTED, [], T0);
  const logic = applyAffectDrift(g, { ...shift('lifted', 'content'), epistemic: 'logic_valid' }, RESTED, [], T0);
  const gap = applyAffectDrift(g, { ...shift('lifted', 'content'), epistemic: 'knowledge_gap' }, RESTED, [], T0);
  const pressure = applyAffectDrift(g, { ...shift('lifted', 'content'), epistemic: 'emotional_pressure' }, RESTED, [], T0);

  assert.equal(plain.next.mood_level, 68, '60 + up(6) + pull(2)');
  assert.equal(logic.next.mood_level, 71, 'up(6) widened by half = 9, + pull(2)');
  assert.equal(gap.next.mood_level, logic.next.mood_level);
  // THE anti-sycophancy pin: being pushed at is not the same as being shown something.
  assert.equal(pressure.next.mood_level, plain.next.mood_level,
    'pressure must never buy a wider step than an ordinary turn');

  // It widens a dip exactly as much as a lift — real information can land badly.
  const down = settled(RESTED, { mood_level: 80 });
  assert.equal(applyAffectDrift(down, shift('dipped', 'content'), RESTED, [], T0).next.mood_level, 74);
  assert.equal(
    applyAffectDrift(down, { ...shift('dipped', 'content'), epistemic: 'logic_valid' }, RESTED, [], T0).next.mood_level,
    70, 'down(8) widened by half = 12, + pull(2)',
  );
});

test('the widening touches mood alone — the clock-driven gauges never read the envelope', () => {
  // One point off each target, so the turn cap has room for the widest mood step going and the
  // four gauges below can never be competing with mood for the last point of the budget.
  const g = settled(HARD, { anxiety: 77, warmth: 45, social_battery: 20, patience: 42, rapport: 40 });
  const base = applyAffectDrift(g, shift('steady', 'irritated'), HARD, [], T0).next;
  assert.deepEqual(
    [base.anxiety, base.warmth, base.social_battery, base.patience],
    [78, 46, 21, 43],
    'each of the four closed the last point to its target',
  );
  for (const epistemic of ['none', 'knowledge_gap', 'logic_valid', 'emotional_pressure'] as const) {
    for (const s of MOOD_SHIFTS) {
      // `broke` is the one shift that changes them, and not because it is read: it eats the cap.
      if (s === 'broke') continue;
      const r = applyAffectDrift(g, { moodShift: s, moodLabel: 'irritated', epistemic }, HARD, [], T0).next;
      for (const k of ['anxiety', 'warmth', 'social_battery', 'patience', 'rapport'] as const) {
        assert.equal(r[k], base[k], `${k} moved with ${s}/${epistemic}`);
      }
    }
  }
});

// ── the clock-driven gauges ─────────────────────────────────────────────────

test('anxiety / warmth / battery / patience step at most their spec toward the clock target', () => {
  const t = affectTargets(HARD);
  for (const key of ['anxiety', 'warmth', 'social_battery', 'patience'] as const) {
    const spec = GAUGE_SPECS.find(s => s.key === key)!;
    // Far below the target: it climbs by `up` and no further.
    const low = applyAffectDrift(settled(HARD, { [key]: 1 }), shift('steady', 'irritated'), HARD, [], T0);
    assert.equal(low.next[key], 1 + spec.up, `${key} up step`);
    // Far above it: it falls by `down`.
    const high = applyAffectDrift(settled(HARD, { [key]: 100 }), shift('steady', 'irritated'), HARD, [], T0);
    assert.equal(high.next[key], 100 - spec.down, `${key} down step`);
    // And it never overshoots a target that is closer than one step.
    const near = applyAffectDrift(settled(HARD, { [key]: t[key] - 1 }), shift('steady', 'irritated'), HARD, [], T0);
    assert.equal(near.next[key], t[key], `${key} overshot its target`);
    const already = applyAffectDrift(settled(HARD), shift('steady', 'irritated'), HARD, [], T0);
    assert.ok(!already.report.changed.includes(key), `${key} moved while already on target`);
  }
});

// ── rapport: structural evidence only ───────────────────────────────────────

test('rapport moves only on how a thread offer landed, never on what she says about it', () => {
  const g = settled(PEAK, { rapport: 50 });
  const took = applyAffectDrift(g, { ...shift('steady', 'content'), threadOutcome: 'took' }, PEAK, [], T0);
  assert.equal(took.next.rapport, 51, 'closeness is earned one point at a time');
  const pushed = applyAffectDrift(g, { ...shift('steady', 'content'), threadOutcome: 'pushed_back' }, PEAK, [], T0);
  assert.equal(pushed.next.rapport, 48, 'and lost two at a time');
  for (const outcome of ['passed', null, undefined] as const) {
    const r = applyAffectDrift(g, { ...shift('steady', 'content'), threadOutcome: outcome }, PEAK, [], T0);
    assert.equal(r.next.rapport, 50, `${String(outcome)} is not evidence either way`);
    assert.ok(!r.report.changed.includes('rapport'));
  }

  // Self-report is not evidence: no shift, word or trigger can move it.
  for (const s of MOOD_SHIFTS) {
    for (const epistemic of ['none', 'logic_valid', 'emotional_pressure'] as const) {
      const r = applyAffectDrift(g, { moodShift: s, moodLabel: 'delightful', epistemic }, PEAK, [], T0);
      assert.equal(r.next.rapport, 50, `rapport moved on a self-reported ${s}/${epistemic}`);
    }
  }

  // A gauge parked on its ceiling reports atBound, exactly as a dial does.
  const maxed = applyAffectDrift(
    settled(PEAK, { rapport: 100 }), { ...shift('steady', 'content'), threadOutcome: 'took' }, PEAK, [], T0,
  );
  assert.deepEqual(maxed.report.atBound, ['rapport']);
  assert.equal(maxed.next.rapport, 100);
});

// ── clock-target monotonicity ───────────────────────────────────────────────

// The coefficients are hand-written, and a flipped sign in one of them would be invisible in every
// test above — the gauge would still move, still stay in range, still respect every budget. These
// two sweeps are what make a sign error fail loudly.
test('a harder cycle day never RAISES patience, and never LOWERS anxiety', () => {
  let prevTarget = Infinity;
  let prevAnxTarget = -Infinity;
  let prevPatience = Infinity;
  for (let load = 1; load <= 100; load++) {
    const c = clock(load, 50);
    const t = affectTargets(c);
    assert.ok(t.patience <= prevTarget, `patience target rose at load ${load}`);
    assert.ok(t.anxiety >= prevAnxTarget, `anxiety target fell at load ${load}`);
    prevTarget = t.patience;
    prevAnxTarget = t.anxiety;

    // End to end, with every other gauge already on its target so patience has the whole budget.
    const r = applyAffectDrift(settled(c, { patience: 50 }), shift('steady', 'content'), c, [], T0);
    assert.ok(r.next.patience <= prevPatience, `patience rose end-to-end at load ${load}`);
    prevPatience = r.next.patience;
  }
  assert.ok(prevPatience < 50, 'and the sweep actually moved it, so this pins a direction');
});

test('a brighter circadian hour never RAISES anxiety, and never LOWERS mood or battery', () => {
  let prevAnxTarget = Infinity;
  let prevMoodTarget = -Infinity;
  let prevBatteryTarget = -Infinity;
  let prevAnx = Infinity;
  for (let energy = 1; energy <= 100; energy++) {
    const c = clock(40, energy);
    const t = affectTargets(c);
    assert.ok(t.anxiety <= prevAnxTarget, `anxiety target rose at energy ${energy}`);
    assert.ok(t.mood_level >= prevMoodTarget, `mood target fell at energy ${energy}`);
    assert.ok(t.social_battery >= prevBatteryTarget, `battery target fell at energy ${energy}`);
    prevAnxTarget = t.anxiety;
    prevMoodTarget = t.mood_level;
    prevBatteryTarget = t.social_battery;

    const r = applyAffectDrift(settled(c, { anxiety: 50 }), shift('steady', 'content'), c, [], T0);
    assert.ok(r.next.anxiety <= prevAnx, `anxiety rose end-to-end at energy ${energy}`);
    prevAnx = r.next.anxiety;
  }
  assert.ok(prevAnx < 50, 'and the sweep actually moved it');
});

// ── purity ──────────────────────────────────────────────────────────────────

test('applyAffectDrift is pure: same inputs same output, and nothing passed in is mutated', () => {
  const before: AffectGauges = {
    mood_level: 62, anxiety: 44, warmth: 58, social_battery: 51, patience: 66, rapport: 43,
  };
  const ledger: AffectMove[] = [{ at: T0 - 30 * 60_000, k: 'mood_level', d: -4 }];
  const snapshot = structuredClone({ before, ledger });
  const input: AffectInput = { ...shift('dipped', 'irritated'), threadOutcome: 'took' };

  const a = applyAffectDrift(before, input, HARD, ledger, T0);
  const b = applyAffectDrift(before, input, HARD, ledger, T0);
  assert.deepEqual(a.next, b.next);
  assert.deepEqual(a.moves, b.moves);
  assert.deepEqual(a.report, b.report);
  assert.deepEqual({ before, ledger }, snapshot, 'an input was mutated');
  assert.notEqual(a.next, before, 'the gauges object is a fresh one');
  assert.notEqual(a.moves, ledger, 'the ledger array is a fresh one');
});

test('the ledger is pruned to the longest window and defensively capped', () => {
  assert.ok(AFFECT_BROKE_WINDOW_MS >= AFFECT_MOOD_WINDOW_MS, 'the prune must keep what the longest window reads');

  // 200 rows for a gauge with no rolling budget of its own, so only the caps are under test.
  const fat: AffectMove[] = Array.from({ length: 200 }, (_, i) => ({ at: T0 - i, k: 'rapport' as const, d: 1 }));
  const r = applyAffectDrift(settled(PEAK, { mood_level: 60 }), shift('steady', 'content'), PEAK, fat, T0);
  assert.equal(r.moves.length, AFFECT_MOVES_CAP);
  assert.ok(r.moves.some(m => m.k === 'mood_level'), "this turn's own move survived the cap");

  // Everything older than the longest window this engine reads is gone.
  const stale: AffectMove[] = [
    { at: T0 - AFFECT_BROKE_WINDOW_MS - 1, k: 'mood_level', d: -3 },
    { at: T0 - 60_000, k: 'mood_level', d: -3 },
  ];
  const pruned = applyAffectDrift(settled(PEAK), shift('steady', 'content'), PEAK, stale, T0);
  assert.deepEqual(pruned.moves.map(m => m.at), [T0 - 60_000]);
});

// ── the invariants, across a grid of turns ──────────────────────────────────

// Every property above holds for a hand-picked fixture. These are the ones that must hold for
// EVERY turn, checked over a deterministic grid: three buckets that never overlap, a `shortened`
// that is always a subset of `changed`, movement inside the cap, and gauges inside their bounds.
test('for every combination of turn and clock, the report is disjoint and the bounds hold', () => {
  const starts: AffectGauges[] = [
    defaultAffectGauges(),
    { mood_level: 1, anxiety: 100, warmth: 1, social_battery: 1, patience: 1, rapport: 1 },
    { mood_level: 100, anxiety: 1, warmth: 100, social_battery: 100, patience: 100, rapport: 100 },
    { mood_level: 62, anxiety: 44, warmth: 58, social_battery: 51, patience: 66, rapport: 43 },
  ];
  const seen = { changed: 0, capped: 0, atBound: 0, shortened: 0 };
  for (const g of starts) {
    for (const c of [NEUTRAL, PEAK, HARD, RESTED, clock(1, 100), clock(100, 1)]) {
      for (const s of MOOD_SHIFTS) {
        for (const label of ['content', 'delightful', 'miserable', 'irritated', 'zzzqqq']) {
          for (const outcome of ['took', 'pushed_back', null] as const) {
            const r = applyAffectDrift(
              g, { moodShift: s, moodLabel: label, epistemic: 'logic_valid', threadOutcome: outcome }, c, [], T0,
            );
            const { changed, capped, atBound, shortened } = r.report;
            for (const bucket of [changed, capped, atBound, shortened]) {
              assert.equal(new Set(bucket).size, bucket.length, 'a gauge listed twice in one bucket');
            }
            for (const k of changed) assert.ok(!capped.includes(k) && !atBound.includes(k), `${k} in two buckets`);
            for (const k of capped) assert.ok(!atBound.includes(k), `${k} capped and atBound`);
            for (const k of shortened) assert.ok(changed.includes(k), `${k} shortened without changing`);
            assert.ok(spentThisTurn(r.moves, T0) <= AFFECT_TURN_CAP, 'a turn spent more than the cap');
            for (const spec of GAUGE_SPECS) {
              const v = r.next[spec.key];
              assert.ok(Number.isInteger(v) && v >= spec.floor && v <= spec.ceiling, `${spec.key} = ${v}`);
            }
            // The band is a hard bound on mood however the turn went.
            const [lo, hi] = CORE_VALENCE_BAND[coreForLabel(label)];
            assert.ok(r.next.mood_level >= lo && r.next.mood_level <= hi,
              `mood ${r.next.mood_level} outside ${label}'s band`);
            seen.changed += changed.length ? 1 : 0;
            seen.capped += capped.length ? 1 : 0;
            seen.atBound += atBound.length ? 1 : 0;
            seen.shortened += shortened.length ? 1 : 0;
          }
        }
      }
    }
  }
  // The grid is only worth trusting if it actually exercised all four buckets.
  for (const [bucket, hits] of Object.entries(seen)) assert.ok(hits > 0, `the grid never produced a ${bucket}`);
});
