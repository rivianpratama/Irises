// The per-turn AFFECT gauges: the fast weather, where climate.ts is the slow standing register.
// Same charter §10.1 bargain as climate (`applyDrift`, `climate.ts:145-207`), and this file is
// deliberately modeled on it line for line — the model contributes a DIRECTION and a WORD, and
// every bound that makes that safe is arithmetic here:
//
//   • `mood_shift` (lifted/steady/dipped/broke) is read through the same `signOf` as a dial
//     suggestion: which way, never how far. A model that insists it feels "completely destroyed"
//     buys exactly the same 8 points as one that says "a bit down".
//   • `mood_label` is a feeling WORD, and the word decides the band the level may sit in
//     (`CORE_VALENCE_BAND` via `coreForLabel`). "delighted at 12" and "miserable at 90" are no
//     longer expressible states — mood.ts called that band guidance; here it is a clamp.
//   • anxiety, warmth, social_battery and patience take NO model input at all. They seek a target
//     computed from the cycle + circadian clock, at most one spec step a turn. This is where
//     "warmth costs more in the low stretch" stops being prose and becomes a coefficient — and it
//     is what finally gives `cycle_load` / `circadian_energy` a consumer.
//   • `rapport` moves on STRUCTURE only: how the last thread offer actually landed. Never on her
//     own report of how close they are, because a gauge that rises when she says it rises is a
//     gauge that will rise (charter §6.4 — warmth that increases reliance is a harm).
//
// The asymmetries are the safety: a dip is cheaper than a lift (8 vs 6) and anxiety climbs faster
// than it falls (8 vs 5), because a state that is quick to earn and slow to shake is what a
// difficult day actually feels like — and because the flattering direction should be the expensive
// one. `AFFECT_TURN_CAP` then bounds the whole turn: no single message can move her more than 18
// points across all six gauges, whatever it says or how many times it says it.
//
// PURE by construction: no DB, no LLM, no clock reads. `now` is always passed in, and neither the
// gauges nor the ledger handed in is ever mutated.

import { clampToSpec, pruneLedger, signOf, spentInWindow } from './climate.js';
import { CORE_VALENCE_BAND, coreForLabel } from './mood.js';
// TYPE-ONLY, and it has to stay that way: status.ts is what will call this engine, so a value
// import here would close a runtime import cycle. These three types are erased at compile time.
import type { ComputedState, EpistemicTrigger, ThreadOutcome } from './status.js';

/** The shape of a row in the gauge table — `DialSpec`'s counterpart (`climate.ts:37-46`). */
interface GaugeSpecShape {
  key: string;
  /** Where a gauge with no stored value starts. Never 0: on a 1-100 gauge that reads as collapse. */
  dflt: number;
  floor: number;
  ceiling: number;
  /** Points added on an upward step. */
  up: number;
  /** Points SUBTRACTED on a downward step (a positive magnitude). */
  down: number;
}

/**
 * The gauge table, and the ONE source of truth for the gauge set (the `THEME_KINDS` /`DIALS`
 * pattern). ORDER IS LOAD-BEARING: `AFFECT_TURN_CAP` is handed out in exactly this order, so mood
 * gets first claim on a turn's movement and rapport gets whatever is left. Every number here is
 * load-bearing too — see the header for why each pair is asymmetric the way it is.
 */
export const GAUGE_SPECS = [
  { key: 'mood_level',     dflt: 50, floor: 1, ceiling: 100, up: 6, down: 8 },
  { key: 'anxiety',        dflt: 50, floor: 1, ceiling: 100, up: 8, down: 5 },
  { key: 'warmth',         dflt: 50, floor: 1, ceiling: 100, up: 4, down: 6 },
  { key: 'social_battery', dflt: 50, floor: 1, ceiling: 100, up: 5, down: 7 },
  { key: 'patience',       dflt: 50, floor: 1, ceiling: 100, up: 5, down: 7 },
  // Closeness starts below the midpoint and is earned a point at a time, lost two at a time.
  { key: 'rapport',        dflt: 40, floor: 1, ceiling: 100, up: 1, down: 2 },
] as const satisfies readonly GaugeSpecShape[];

export type GaugeKey = (typeof GAUGE_SPECS)[number]['key'];

export type GaugeSpec = GaugeSpecShape & { key: GaugeKey };

/** Every gauge the model no longer reports, keyed 1-100. */
export type AffectGauges = Record<GaugeKey, number>;

/** The gauges that seek a clock target. `rapport` is the exception: it answers to evidence only. */
export type TargetedGaugeKey = Exclude<GaugeKey, 'rapport'>;

/** One applied step, kept only long enough to enforce the rolling budgets and to be auditable.
 *  `broke` marks the step that spent the once-per-6h allowance, so the next one can be refused. */
export interface AffectMove { at: number; k: GaugeKey; d: number; broke?: true }

/** The direction the model reports for mood, and the whole of its influence over the level.
 *  `broke` is the exception it may reach for at most once every six hours. */
export const MOOD_SHIFTS = ['lifted', 'steady', 'dipped', 'broke'] as const;

export type MoodShift = (typeof MOOD_SHIFTS)[number];

/** Everything one turn contributes. Four fields, three of them the model's judgment and one
 *  (`threadOutcome`) structural — how her LAST reply's thread offer actually landed. */
export interface AffectInput {
  moodShift: MoodShift;
  moodLabel: string;
  epistemic: EpistemicTrigger;
  threadOutcome?: ThreadOutcome | null;
}

/**
 * Where every gauge the turn touched ended up. `changed` / `capped` / `atBound` are DISJOINT — a
 * gauge that wanted to move lands in exactly one of them, so a step that vanished can always be
 * explained. `shortened` is a marker on top of `changed` (never on the other two), the same
 * relationship `applyDrift` reports:
 *   • `changed`   — it moved.
 *   • `capped`    — a budget left nothing. It CAN move, just not now: the turn cap was already
 *                   spent by an earlier gauge, or mood had used its hour.
 *   • `atBound`   — parked on its floor/ceiling (for mood, on the edge of the word's valence
 *                   band), so the step had nowhere to go. A PERMANENT condition while it lasts,
 *                   and it reads identically to "the model stopped suggesting anything" unless it
 *                   is reported separately.
 *   • `shortened` — it moved, but by less than the rule asked for: a budget truncated the step,
 *                   or a second `broke` inside six hours was downgraded to a plain dip.
 *
 * The last two fields are about the turn rather than about a step, and they exist so a caller never
 * has to diff `current` against `next` and guess which rule did it.
 */
export interface AffectDriftReport {
  changed: GaugeKey[];
  capped: GaugeKey[];
  atBound: GaugeKey[];
  shortened: GaugeKey[];
  /** Gauges whose STORED level a bound moved during seeding, before the turn asked for anything —
   *  for mood the reported word's valence band, for the rest their 1-100 range. A COERCION, not a
   *  step: it appears in none of the four buckets above and spends none of the turn's budget. A
   *  gauge that had no usable level at all is not here — it was seeded from its `dflt`, and there
   *  was no level to snap. */
  coerced: GaugeKey[];
  /** A `broke` arrived with the six hours already spent, so it was served as an ordinary dip. True
   *  whatever became of that dip afterwards — landed, truncated, refused by a budget, or swallowed
   *  by a bound — because `shortened` can only speak for a step that actually moved. */
  brokeDowngraded: boolean;
}

/** How far the clock may pull mood in one turn. Deliberately tiny next to a 6-8 point shift: the
 *  model's read of THIS message must always outweigh the simulation running underneath it. */
export const MOOD_TARGET_PULL = 2;
/** What `broke` buys: three steps at once, i.e. most of a turn's entire cap. */
export const BROKE_STEP_MULTIPLIER = 3;
/** `logic_valid` / `knowledge_gap` widen the mood step by half. The anti-sycophancy asymmetry:
 *  being shown something may move her further than being pushed at ever does. */
export const EPISTEMIC_STEP_WIDENING = 1.5;
/** Summed |movement| across ALL gauges in one turn. The ceiling on what one message can do. */
export const AFFECT_TURN_CAP = 18;
/** Mood's own rolling budget, so a burst of messages cannot walk the level across the range. */
export const AFFECT_MOOD_WINDOW_MS = 60 * 60 * 1000;
export const AFFECT_MOOD_WINDOW_CAP = 20;
/** `broke` is allowed once inside this window; the second one is an ordinary dip. */
export const AFFECT_BROKE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Defensive ceiling on the ledger rows NO budget reads any more — everything except an in-window
 *  `broke` and a mood row inside the hour. It cannot be applied to the whole array: the ledger is
 *  kept newest-last, so a blanket cap drops the OLDEST rows, and the oldest rows are exactly the
 *  ones a rolling window is counted from. Six rows can arrive in one turn, so 64 fills in a few
 *  dozen turns — far inside the six hours a break is meant to be remembered for.
 *  What it still bounds: the ordinary gauge rows, and mood rows already too old for the hour, on a
 *  clock that jumped backwards or a ledger hand-edited into nonsense. What it no longer needs to
 *  bound is bounded by the budgets themselves — a mood row is only written when at least one point
 *  landed, so the hour can hold at most `AFFECT_MOOD_WINDOW_CAP` of them, plus the one `broke` the
 *  six hours allow. */
export const AFFECT_MOVES_CAP = 64;

/** The ledger must keep whatever the LONGEST window still reads, or `broke` would forget itself. */
const LEDGER_WINDOW_MS = Math.max(AFFECT_MOOD_WINDOW_MS, AFFECT_BROKE_WINDOW_MS);

/** A shift is a sign and nothing else. Off-enum values give `undefined` → `signOf` → steady. */
const MOOD_SHIFT_SIGN: Record<MoodShift, number> = { lifted: 1, steady: 0, dipped: -1, broke: -1 };

/** The only evidence rapport ever answers to. `passed` is not evidence either way. */
const THREAD_OUTCOME_SIGN: Record<ThreadOutcome, number> = { took: 1, passed: 0, pushed_back: -1 };

/** Real information, as opposed to pressure. */
const WIDENING_TRIGGERS: readonly EpistemicTrigger[] = ['logic_valid', 'knowledge_gap'];

const GAUGE_RANGE = { floor: 1, ceiling: 100 };

/** A fresh chat: every gauge at its own default. */
export function defaultAffectGauges(): AffectGauges {
  const gauges = {} as AffectGauges;
  for (const spec of GAUGE_SPECS) gauges[spec.key] = spec.dflt;
  return gauges;
}

/**
 * Where the CLOCK says each gauge belongs right now — the consumer `cycle_load` and
 * `circadian_energy` never had. Read the signs, not the constants: a harder cycle day lowers mood,
 * warmth and patience and raises anxiety; a brighter circadian hour does the reverse. Those
 * directions are the whole content of this function, and `affectDrift.test.ts` sweeps both inputs
 * end to end precisely because a flipped sign here would be invisible everywhere else.
 *
 * Nothing snaps to a target: it is somewhere to drift toward, at most one spec step a turn.
 */
export function affectTargets(computed: ComputedState): Record<TargetedGaugeKey, number> {
  const load = computed.cycle.load;
  const energy = computed.circadian.energy;
  return {
    mood_level: clampToSpec(55 + 0.25 * (energy - 50) - 0.30 * (load - 40), GAUGE_RANGE),
    anxiety: clampToSpec(35 + 0.45 * load - 0.25 * (energy - 50), GAUGE_RANGE),
    // Warmth is always available; on a hard day at a bad hour it simply costs more to produce.
    warmth: clampToSpec(60 + 0.30 * (energy - 50) - 0.20 * (load - 40), GAUGE_RANGE),
    social_battery: clampToSpec(20 + 0.70 * energy - 0.25 * load, GAUGE_RANGE),
    patience: clampToSpec(75 - 0.35 * load + 0.15 * (energy - 50), GAUGE_RANGE),
  };
}

/** A gauge's bounds this turn. Mood's are the reported word's valence band — narrower than 1-100,
 *  and the reason the band is now a clamp rather than a suggestion in the prompt. */
function boundsFor(spec: GaugeSpec, moodLabel: string): { floor: number; ceiling: number } {
  if (spec.key !== 'mood_level') return { floor: spec.floor, ceiling: spec.ceiling };
  const [lo, hi] = CORE_VALENCE_BAND[coreForLabel(moodLabel)];
  return { floor: Math.max(spec.floor, lo), ceiling: Math.min(spec.ceiling, hi) };
}

/** The mood rule: the shift's sign × its (possibly widened, possibly tripled) step, then a pull of
 *  at most `MOOD_TARGET_PULL` toward the clock. `downgraded` says the 3× step was refused. */
function moodDelta(
  spec: GaugeSpec, cur: number, input: AffectInput, target: number, downgraded: boolean,
): number {
  const sign = signOf(MOOD_SHIFT_SIGN[input.moodShift]);
  const multiplier = input.moodShift === 'broke' && !downgraded ? BROKE_STEP_MULTIPLIER : 1;
  const widening = WIDENING_TRIGGERS.includes(input.epistemic) ? EPISTEMIC_STEP_WIDENING : 1;
  const step = sign === 0 ? 0 : Math.round((sign > 0 ? spec.up : spec.down) * multiplier * widening);
  const gap = target - (cur + sign * step);
  const pull = signOf(gap) * Math.min(Math.abs(gap), MOOD_TARGET_PULL);
  return sign * step + pull;
}

/** What one gauge's own rule asks for this turn, before any bound or budget touches it. */
function wantedFor(
  spec: GaugeSpec,
  cur: number,
  input: AffectInput,
  targets: Record<TargetedGaugeKey, number>,
  brokeDowngraded: boolean,
): number {
  const key: GaugeKey = spec.key;
  if (key === 'mood_level') return moodDelta(spec, cur, input, targets.mood_level, brokeDowngraded);
  if (key === 'rapport') {
    const sign = signOf(input.threadOutcome ? THREAD_OUTCOME_SIGN[input.threadOutcome] : 0);
    return sign > 0 ? spec.up : sign < 0 ? -spec.down : 0;
  }
  // The four clock-driven gauges: toward the target, by at most one spec step.
  const gap = targets[key] - cur;
  const sign = signOf(gap);
  return sign * Math.min(Math.abs(gap), sign > 0 ? spec.up : spec.down);
}

/**
 * Fold one turn into the gauges. Every clamp is here, in this order — the same order, for the same
 * reasons, as `applyDrift` (`climate.ts:118-144`):
 *   0. seed: a missing or garbled gauge starts from its `dflt`, and every gauge is clamped into its
 *      bounds before anything is asked of it. For mood that is the word's valence band, so a level
 *      stored outside it comes back inside — a COERCION, not a step: it spends none of the turn's
 *      budget and appears in none of the four movement buckets, only in `report.coerced`.
 *   1. the gauge's own rule (above): a sign × an asymmetric step for mood and rapport, a bounded
 *      pull toward the clock target for the four in between.
 *   2. clamp to [floor, ceiling] FIRST, so a gauge already parked on a bound asks the budget for
 *      nothing and spends none of it standing still.
 *   3. the turn cap: the step is TRUNCATED to whatever is left of `AFFECT_TURN_CAP`, in
 *      `GAUGE_SPECS` order. Mood additionally answers to its rolling hour.
 * Then the applied delta is appended to the ledger, rows outside the longest window are pruned, and
 * the rows no budget reads any more are defensively capped at `AFFECT_MOVES_CAP`.
 *
 * PURE: `current` and `ledger` are never mutated, and the same inputs always give the same result.
 */
export function applyAffectDrift(
  current: AffectGauges,
  input: AffectInput,
  computed: ComputedState,
  ledger: readonly AffectMove[],
  now: number,
): { next: AffectGauges; moves: AffectMove[]; report: AffectDriftReport } {
  const targets = affectTargets(computed);
  // Both budgets are read off the ledger handed in, before this turn appends to it.
  const brokeSpent = ledger.some(m => m.broke === true && m.at > now - AFFECT_BROKE_WINDOW_MS);
  const brokeDowngraded = input.moodShift === 'broke' && brokeSpent;
  const moodWindowLeft = Math.max(
    0, AFFECT_MOOD_WINDOW_CAP - spentInWindow(ledger, 'mood_level', now, AFFECT_MOOD_WINDOW_MS),
  );

  const bounds = {} as Record<GaugeKey, { floor: number; ceiling: number }>;
  const next = {} as AffectGauges;
  const coerced: GaugeKey[] = [];
  for (const spec of GAUGE_SPECS) {
    bounds[spec.key] = boundsFor(spec, input.moodLabel);
    const raw = (current as Partial<AffectGauges> | undefined)?.[spec.key];
    const stored = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const seeded = clampToSpec(stored ?? spec.dflt, bounds[spec.key]);
    next[spec.key] = seeded;
    // A BOUND moving the stored level is the coercion; rounding it is not, and a gauge with no
    // usable level was seeded from its default rather than snapped away from one.
    if (stored !== null && seeded !== Math.round(stored)) coerced.push(spec.key);
  }

  const moves: AffectMove[] = [...ledger];
  const report: AffectDriftReport = {
    changed: [], capped: [], atBound: [], shortened: [], coerced, brokeDowngraded,
  };
  let spent = 0;

  for (const spec of GAUGE_SPECS) {
    const cur = next[spec.key];
    const delta = wantedFor(spec, cur, input, targets, brokeDowngraded);
    if (delta === 0) continue;

    const wanted = clampToSpec(cur + delta, bounds[spec.key]) - cur;
    // A gauge sitting on a bound swallows the whole step. Reported, not silently dropped:
    // otherwise a mood pinned to the bottom of `miserable` looks in diagnostics exactly like a
    // turn the model reported nothing for.
    if (wanted === 0) {
      report.atBound.push(spec.key);
      continue;
    }

    let budget = Math.max(0, AFFECT_TURN_CAP - spent);
    if (spec.key === 'mood_level') budget = Math.min(budget, moodWindowLeft);
    const applied = Math.sign(wanted) * Math.min(Math.abs(wanted), budget);
    if (applied === 0) {
      report.capped.push(spec.key);
      continue;
    }
    // A step the budget cut down, or a `broke` refused its 3× — either way it landed smaller than
    // the rule asked for, and a step that quietly shrank is indistinguishable from a smaller
    // suggestion unless it says so.
    if (applied !== wanted || (spec.key === 'mood_level' && brokeDowngraded)) {
      report.shortened.push(spec.key);
    }

    next[spec.key] = cur + applied;
    spent += Math.abs(applied);
    // Only a break that actually LANDED claims the next six hours.
    const claimsBreak = spec.key === 'mood_level' && input.moodShift === 'broke' && !brokeDowngraded;
    moves.push(claimsBreak
      ? { at: now, k: spec.key, d: applied, broke: true }
      : { at: now, k: spec.key, d: applied });
    report.changed.push(spec.key);
  }

  return {
    next,
    // The pin is the two budgets read above: an in-window break, and a mood row inside the hour.
    // Dropping one of those would not just shorten an audit trail, it would hand a spent budget back.
    moves: pruneLedger(
      moves, now, LEDGER_WINDOW_MS, AFFECT_MOVES_CAP,
      m => (m.broke === true && m.at > now - AFFECT_BROKE_WINDOW_MS)
        || (m.k === 'mood_level' && m.at > now - AFFECT_MOOD_WINDOW_MS),
    ),
    report,
  };
}
