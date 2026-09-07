// A simulated 28-day infradian cycle that biases Irises's mood baseline. This is an INTERNAL
// modulator only — it shapes how much warmth costs, how loud the anxiety runs, how thin the
// filter is. It is NEVER named, hinted, or turned into a reason she gives the user ("I'm off
// today because…"). The safety line in PERSONA.md holds: no self-diagnosis, no turning an
// inferred internal state into a stated fact.
//
// Anchored to a single fixed "day 1" date (IRISES_CYCLE_ANCHOR, single-user so one anchor).
// Ported from Martins-Crib's getAliceCyclePhase, grounded in the same hormonal framing
// (estrogen lifts emotion-recognition + social buoyancy; luteal progesterone raises reactivity
// and interpersonal anxiety; late luteal is the hardest).
//
// It reaches the prompt as ARITHMETIC ONLY, and that is the whole of what survives here: `load`
// feeds the gauge targets (persona/affectDrift.ts affectTargets), which feed the two gauges the
// affect compiler reads. The four paragraphs of phase texture this file used to hand the model on
// every turn are deleted — they described a state instead of changing a reply, and the one thing a
// phase actually changes now arrives as an imperative compiled from where the gauges landed.

export type CyclePhase = 'menstrual' | 'follicular' | 'ovulation' | 'luteal';

const DAY_MS = 86_400_000;

export interface CycleState {
  phase: CyclePhase;
  day: number;        // 1-28
  load: number;       // 1-100: how hard the phase pulls on mood/warmth/anxiety this day
}

/** Day 1-28 of the cycle for `nowMs`, counting whole days from the anchor. */
export function cycleDay(nowMs: number, anchorMs: number): number {
  const diff = nowMs - anchorMs;
  const days = Math.floor(diff / DAY_MS);
  // JS % keeps the sign of the dividend; add 28 before the final mod so a pre-anchor date is still 1-28.
  return (((days % 28) + 28) % 28) + 1;
}

export function phaseForDay(day: number): CyclePhase {
  if (day <= 5) return 'menstrual';
  if (day <= 13) return 'follicular';
  if (day === 14) return 'ovulation';
  return 'luteal';
}

/** 1-100 pull. Highest at menstruation and late luteal; lowest at ovulation. */
function loadForDay(day: number, phase: CyclePhase): number {
  switch (phase) {
    case 'menstrual':
      // Days 1-2 hardest, easing toward follicular.
      return Math.round(80 - (day - 1) * 6); // 80 → 56
    case 'follicular':
      return 25;
    case 'ovulation':
      return 10;
    case 'luteal': {
      // Ramps from early-luteal calm (day 15) to late-luteal peak (day 28).
      const t = (day - 15) / (28 - 15); // 0..1
      return Math.round(40 + t * 45); // 40 → 85
    }
  }
}

/** Full cycle state for the given instant against the configured anchor. */
export function computeCycle(nowMs: number, anchorMs: number): CycleState {
  const day = cycleDay(nowMs, anchorMs);
  const phase = phaseForDay(day);
  return { phase, day, load: loadForDay(day, phase) };
}
