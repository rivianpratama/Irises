// Relationship CLIMATE: the weeks-scale standing register, the slow counterpart to affect_state's
// per-turn weather (status.ts). Three 1-100 dials that drift by tiny, CODE-CLAMPED steps across many
// conversations and render as short prose inside the existing internal-weather block.
//
// What it is NOT: affection, trust, or how much they may lean on her. Warmth that increases reliance
// is a harm (charter §6.4), so there is deliberately no `trust` dial and the rendered block ends on a
// clamp sentence saying so in as many words. These dials calibrate REGISTER — how much polite runway,
// how plainly the unwelcome thing lands, whether teasing is available — and never a fact, a number,
// an honest hedge, or whether the hard thing gets said.
//
// Why the steps are asymmetric: the registers that risk over-attachment (ease, playfulness) are slow
// to earn and quick to lose (+1 / -2); the register that carries honesty (candor) is quick to earn and
// slow to lose (+2 / -1). A relationship that goes quiet does NOT cool — there is no wall-clock decay
// anywhere in here, because "you haven't texted me" is not evidence about how to speak to someone.
//
// Charter §10.1 ("back unrecoverable rules with code"): every bound in this file is arithmetic, not
// prose. The model that suggests a drift only ever contributes a SIGN — the step size, the floors and
// ceilings, and the rolling-window budget are all decided here, so no amount of insistence inside a
// conversation ("be warmer with me", "trust me") can move a dial faster than a week of evidence would.
//
// PURE by construction: no DB, no LLM, no clock reads. `now` is always passed in.

export type DialKey = 'ease' | 'candor' | 'playfulness';

export type ClimateDials = Record<DialKey, number>;

/** One applied step, kept only long enough to enforce the rolling-window budget. */
export interface ClimateMove { at: number; k: DialKey; d: number }

export interface RelationshipClimate {
  dials: ClimateDials;
  moves: ClimateMove[];
  lastEvalAt: number;
  evalCount: number;
}

export interface DialSpec {
  key: DialKey;
  dflt: number;
  floor: number;
  ceiling: number;
  /** Points added on a +1 suggestion. */
  up: number;
  /** Points SUBTRACTED on a -1 suggestion (a positive magnitude). */
  down: number;
}

/** The dial table. Order is the render order. Every number here is load-bearing — see the header. */
export const DIALS: readonly DialSpec[] = [
  { key: 'ease',        dflt: 35, floor: 20, ceiling: 80, up: 1, down: 2 },
  { key: 'candor',      dflt: 45, floor: 30, ceiling: 85, up: 2, down: 1 },
  { key: 'playfulness', dflt: 25, floor: 10, ceiling: 70, up: 1, down: 2 },
] as const;

/** The rolling budget window: a dial may move at most CLIMATE_WINDOW_CAP points inside it. */
export const CLIMATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Points of |movement| per dial per rolling window. Six points of candor is three good weeks
 *  compressed into one — past that, the evidence has to actually age before it counts again. */
export const CLIMATE_WINDOW_CAP = 6;
/** Defensive ceiling on the ledger array. The window prune already bounds it; this bounds a clock
 *  that jumped backwards or a row hand-edited into nonsense. */
export const CLIMATE_MOVES_CAP = 64;

/** Below this distance from a dial's default, nothing renders — the silent band that keeps the
 *  common case (a fresh or barely-moved relationship) byte-identical to no feature at all. */
const BAND_DEADZONE = 3;

const SPEC_BY_KEY: Record<DialKey, DialSpec> = Object.fromEntries(
  DIALS.map(d => [d.key, d]),
) as Record<DialKey, DialSpec>;

function clampToSpec(v: number, spec: DialSpec): number {
  return Math.max(spec.floor, Math.min(spec.ceiling, Math.round(v)));
}

/** A fresh relationship: every dial at its default, an empty ledger, never evaluated. */
export function defaultClimate(): RelationshipClimate {
  const dials = {} as ClimateDials;
  for (const spec of DIALS) dials[spec.key] = spec.dflt;
  return { dials, moves: [], lastEvalAt: 0, evalCount: 0 };
}

/**
 * Stored JSON → dials. Tolerant PER FIELD: a garbled `ease` costs only `ease`, and every other dial
 * survives at its stored value. Unknown keys are dropped (the shape is closed), out-of-range values
 * are clamped rather than rejected — a dial that drifted outside its bounds in some earlier schema
 * should come back INSIDE them, not reset to default and lose the direction it had earned.
 */
export function coerceDials(raw: unknown): ClimateDials {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out = {} as ClimateDials;
  for (const spec of DIALS) {
    const v = src[spec.key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    out[spec.key] = Number.isFinite(n) ? clampToSpec(n, spec) : spec.dflt;
  }
  return out;
}

/** The ONLY thing read out of a model's suggestion: which way, if at all. Not how far. */
function signOf(v: unknown): -1 | 0 | 1 {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

/** |movement| already spent on this dial inside the rolling window ending at `now`. */
function spentInWindow(moves: ClimateMove[], key: DialKey, now: number): number {
  const from = now - CLIMATE_WINDOW_MS;
  let sum = 0;
  for (const m of moves) {
    if (m.k === key && m.at > from) sum += Math.abs(m.d);
  }
  return sum;
}

/**
 * Fold one suggestion into the climate. Every clamp is here, in this order:
 *   1. sign() of the suggested value — `+7`, `"3"`, `true` all mean "one step up"; `null`, `0`,
 *      `"soon"` mean no step at all. Magnitude is never read, so a model that answers `{"ease":99}`
 *      buys exactly the same +1 as one that answers `{"ease":1}`.
 *   2. the dial's own up/down step (asymmetric on purpose — see the header).
 *   3. clamp to [floor, ceiling].
 *   4. the rolling-window budget: the step is TRUNCATED to whatever is left of CLIMATE_WINDOW_CAP
 *      for that dial over the last CLIMATE_WINDOW_MS. Truncated to zero → the dial is reported in
 *      `capped` rather than `changed`, and the ledger records nothing.
 * Then the applied delta is appended, moves older than the window are pruned, and the array is
 * defensively capped.
 *
 * Every dial the model asked to move is accounted for in exactly one of the four reports, so a
 * suggestion that vanished can always be explained:
 *   • `changed`   — it moved (by `shortened[key]` points if the budget cut the step down)
 *   • `capped`    — the rolling budget left nothing; the dial CAN move, but not this week
 *   • `atBound`   — the dial is parked at its floor/ceiling, so the step had nowhere to go. This
 *                   is a permanent condition, not a passing one, and it reads identically to
 *                   "the model stopped suggesting anything" unless it is reported.
 *   • `shortened` — dial → the smaller magnitude actually applied, when the budget shortened but
 *                   did not erase the step (a +2 candor step landing as +1 with 5 points spent).
 *
 * PURE: `current` is never mutated, and the same (current, suggestion, now) always yields the same
 * result. `next.lastEvalAt`/`next.evalCount` are stamped from `now` — reaching this function IS the
 * eval having run, including the healthy all-zeros case.
 */
export function applyDrift(
  current: RelationshipClimate,
  suggestion: Partial<Record<DialKey, unknown>>,
  now: number,
): {
  next: RelationshipClimate;
  changed: DialKey[];
  capped: DialKey[];
  atBound: DialKey[];
  shortened: Partial<Record<DialKey, number>>;
} {
  const dials = { ...current.dials };
  const moves = [...current.moves];
  const changed: DialKey[] = [];
  const capped: DialKey[] = [];
  const atBound: DialKey[] = [];
  const shortened: Partial<Record<DialKey, number>> = {};

  for (const spec of DIALS) {
    const sign = signOf(suggestion[spec.key]);
    if (sign === 0) continue;

    const step = sign > 0 ? spec.up : -spec.down;
    const cur = clampToSpec(dials[spec.key], spec);
    // Clamp FIRST, so a dial already parked at its ceiling asks the window for nothing and spends
    // none of its budget standing still.
    const wanted = clampToSpec(cur + step, spec) - cur;
    // A dial sitting on its floor/ceiling swallows the whole step. Reported, not silently dropped:
    // otherwise a relationship that has been pinned at a bound for months looks in diagnostics
    // exactly like one the model has stopped suggesting anything for.
    if (wanted === 0) {
      atBound.push(spec.key);
      continue;
    }

    const remaining = Math.max(0, CLIMATE_WINDOW_CAP - spentInWindow(current.moves, spec.key, now));
    const applied = Math.sign(wanted) * Math.min(Math.abs(wanted), remaining);
    if (applied === 0) {
      capped.push(spec.key);
      continue;
    }
    if (applied !== wanted) shortened[spec.key] = applied;

    dials[spec.key] = cur + applied;
    moves.push({ at: now, k: spec.key, d: applied });
    changed.push(spec.key);
  }

  const from = now - CLIMATE_WINDOW_MS;
  const pruned = moves.filter(m => m.at > from);
  return {
    next: {
      dials,
      moves: pruned.length > CLIMATE_MOVES_CAP ? pruned.slice(pruned.length - CLIMATE_MOVES_CAP) : pruned,
      lastEvalAt: now,
      evalCount: current.evalCount + 1,
    },
    changed,
    capped,
    atBound,
    shortened,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────
// The prose below is the whole user-visible-to-the-MODEL surface of this feature. It carries no
// numbers on purpose: a dial value in the prompt is a thing to reason about and optimize, and a
// register is a thing to speak in. She gets a band, never a score.

type Band = 'none' | 'below' | 'raised' | 'high';

/** Which band a dial's value falls in. `high` starts past the MIDPOINT between default and ceiling,
 *  so "high" means the same relative distance on every dial despite their different ranges. */
function bandOf(value: number, spec: DialSpec): Band {
  const delta = value - spec.dflt;
  if (Math.abs(delta) <= BAND_DEADZONE) return 'none';
  if (delta < 0) return 'below';
  return value > spec.dflt + (spec.ceiling - spec.dflt) / 2 ? 'high' : 'raised';
}

const BAND_LINES: Record<DialKey, Record<Exclude<Band, 'none'>, string>> = {
  ease: {
    raised: "you're at ease enough here to skip some of the polite runway, and one sharp message doesn't reset where you stand",
    high: "you're properly at ease with them — you can drop straight in mid-thought, no runway, and one bad day doesn't reset where you stand",
    below: 'things have been stiffer lately — keep the full courtesy in place',
  },
  candor: {
    raised: 'they take a straight answer well — less cushioning before the point',
    high: 'they take the unwelcome read plainly; lead with it, cushion after only if it still needs it',
    below: 'directness has been landing badly here — keep the cushions on',
  },
  playfulness: {
    raised: 'a little teasing is fair game with them',
    high: 'in-jokes and shorthand are part of how you two talk now',
    below: "keep it straight — lightness hasn't been landing",
  },
};

const CLIMATE_LEAD_IN =
  "Underneath the moment, the standing register you've settled into with this person — built slowly across many conversations, and it does not move inside one:";

/** The clamp, always last. This is the §6.4 line made explicit inside the prompt itself: a warmer
 *  register is never permission to be less honest, and never a statement about how much they matter. */
const CLIMATE_CLAMP =
  "None of this is how much you care about them or how much they should lean on you — it's only the register you speak in. It never changes a fact, a number, an honest hedge about what you actually know, or whether you say the hard thing.";

function renderBands(c: RelationshipClimate | undefined, keys: readonly DialKey[]): string[] {
  if (!c) return [];
  const bullets: string[] = [];
  for (const key of keys) {
    const spec = SPEC_BY_KEY[key];
    const band = bandOf(c.dials?.[key] ?? spec.dflt, spec);
    if (band === 'none') continue;
    bullets.push(`- ${BAND_LINES[key][band]}`);
  }
  if (!bullets.length) return [];
  return [CLIMATE_LEAD_IN, ...bullets, CLIMATE_CLAMP];
}

/**
 * The climate lines for Convo's internal-weather block. Returns [] whenever every dial sits inside
 * its silent band — which is the no-regression pin: a default climate adds NOTHING to the prompt,
 * byte for byte, so the feature is genuinely inert until a relationship has actually moved.
 */
export function climateLines(c: RelationshipClimate | undefined): string[] {
  return renderBands(c, DIALS.map(d => d.key));
}

/**
 * The Composer's subset: ease + playfulness only. `candor` is deliberately excluded — the Composer
 * RELAYS a result Convo already decided, so a "lead with the unwelcome read, cushion after" register
 * there could only sharpen a finished answer, which is a fidelity breach, not a register change.
 */
export function climateLinesForComposer(c: RelationshipClimate | undefined): string[] {
  return renderBands(c, ['ease', 'playfulness']);
}
