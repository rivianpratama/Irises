// Pure pacing math for the outbound send path (the timer/HTTP plumbing lives in index.ts).
// Kept side-effect-free and dependency-injected so the rules can be unit-tested directly,
// same pattern as batchTiming.ts.
//
// Design intent ("fast but human"): the user has ALREADY waited through the burst-settle
// window plus the whole LLM call with typing dots showing, so the first bubble gets only a
// short beat (firstBubbleMaxMs) before landing. Later bubbles pace at a fast-texter typing
// speed with a floor (so a tiny "on it" still reads as typed), a cap (so a long bubble never
// stalls the reply), and a little multiplicative jitter so the cadence isn't metronomic.

export interface PacingConfig {
  cpm: number;              // simulated typing speed, chars per minute
  minMs: number;            // floor: even a tiny bubble holds at least this long
  maxMs: number;            // cap: a long bubble never holds past this
  firstBubbleMaxMs: number; // tighter cap for bubble 1 (user already waited through the LLM call)
  jitterPct: number;        // ±% multiplicative jitter; 0 disables
}

/**
 * Simulated typing time for one bubble: chars/cpm, clamped to [minMs, maxMs], jittered, and —
 * for the FIRST bubble of a reply — additionally clamped to firstBubbleMaxMs (applied after
 * jitter so first-ink latency stays hard-bounded).
 */
export function typingDelayMs(
  text: string,
  cfg: PacingConfig,
  isFirstBubble: boolean,
  rand: () => number = Math.random,
): number {
  const chars = text.trim().length || 1;
  const raw = (chars / cfg.cpm) * 60000;
  let ms = Math.min(Math.max(raw, cfg.minMs), cfg.maxMs);
  if (cfg.jitterPct > 0) ms *= 1 + ((rand() * 2 - 1) * cfg.jitterPct) / 100;
  if (isFirstBubble) ms = Math.min(ms, cfg.firstBubbleMaxMs);
  return Math.round(ms);
}

export interface HoldDeps {
  sleep: (ms: number) => Promise<unknown>;
  ping: () => void;   // fire-and-forget typing-indicator re-assert — must NOT return an awaited promise
  now: () => number;
}

/**
 * Hold for `totalMs` of wall-clock time, re-asserting the typing indicator every `refreshMs` so
 * the dots never auto-expire into dead air. Pings are fire-and-forget: their HTTP round trips
 * never extend the hold (the old awaited version stacked ~1 RTT per refresh on top of the sleep
 * budget). Deadline-based, so oversleeps don't accumulate either.
 *
 * `finalPing` re-asserts the dots once more right before returning, guaranteeing they're fresh at
 * the moment the bubble is sent. Callers must pass false before the LAST bubble of a reply: a
 * fire-and-forget ping racing past that final send would re-show dots AFTER the reply completed,
 * reading as "more coming" when nothing is.
 */
export async function holdLoop(totalMs: number, refreshMs: number, finalPing: boolean, deps: HoldDeps): Promise<void> {
  if (totalMs > 0) {
    const deadline = deps.now() + totalMs;
    deps.ping();
    for (;;) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await deps.sleep(Math.min(refreshMs, remaining));
      if (deadline - deps.now() > 0) deps.ping();
    }
  }
  if (finalPing) deps.ping();
}
