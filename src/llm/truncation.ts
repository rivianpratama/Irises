/**
 * Provider-neutral truncation detection: did the model run out of completion budget?
 *
 * The two lanes name it differently — Anthropic `stop_reason: 'max_tokens'`, OpenRouter
 * `finish_reason: 'length'` — and every guard in the tree checked only the OpenRouter spelling, so
 * Anthropic truncation was invisible: half-written dossiers persisted, Judge downgraded urgent mail
 * because its tool call never fit, Ops escalated at full cost for what was really a budget cut.
 * One predicate, used everywhere, closes that blind spot.
 *
 * Starvation is the harsher variant: the whole budget went to reasoning/thinking and the reply
 * carries no text AND no tool call. That is not an "empty reply" — an identical retry starves
 * identically — so callers throw starvedError, which is statusless (hence fallbackable per
 * shouldFallback) and marked so the fallback lane can retry with a BIGGER budget.
 *
 * Pure module: no imports, no I/O, no env reads.
 */

/** True when the provider cut the completion off at the cap.
 *  Anthropic spells it 'max_tokens'; OpenRouter (OpenAI-compatible) spells it 'length'. */
export function isTruncatedStop(stopReason: string | null | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
}

/** Marker property set by starvedError and read by isStarvedError. */
interface StarvedMarker { lengthStarved?: boolean }

/** A truncated reply with NOTHING usable in it (no text, no tool call) — the reasoning-model
 *  starvation mode. Statusless on purpose: shouldFallback treats it as transient, so the turn is
 *  salvaged on the other lane, and the message names the cap so the cause is readable in traces.
 *  `maxTokensSent` is the cap actually sent (per-call override ?? role ceiling), not the ceiling. */
export function starvedError(provider: string, model: string, maxTokensSent: number): Error {
  const err = new Error(
    `${provider} length-starved: model=${model} max_tokens=${maxTokensSent} ` +
    'spent the completion budget (likely on reasoning/thinking) with no content',
  ) as Error & StarvedMarker;
  err.lengthStarved = true;
  return err;
}

/** True for errors built by starvedError. Non-starved errors (including plain Errors whose text
 *  happens to mention starvation) are false — the marker is the only signal. */
export function isStarvedError(err: unknown): boolean {
  return (err as StarvedMarker)?.lengthStarved === true;
}

/** The budget a starved retry should run with: double what was sent, floored at 1024, clamped to
 *  the role ceiling. Only the tiny hardcoded per-call caps (20, 100, 500, 900) actually grow —
 *  a call already at its role ceiling gets the same number back, because doubling past the ceiling
 *  is how a starving reasoning model turns one failure into an unbounded bill. `roleCeiling` is
 *  itself floored at 1024 so a misconfigured sub-1024 ceiling can't clamp the floor away. */
export function bumpStarvedBudget(sent: number, roleCeiling: number): number {
  return Math.min(Math.max(sent * 2, 1024), Math.max(roleCeiling, 1024));
}
