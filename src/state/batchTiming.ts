// Pure decision logic for the burst batcher (the timer plumbing lives in index.ts). Kept
// side-effect-free so the rules can be unit-tested directly. Batching does NOT consult the user's
// typing indicator — it proved unreliable. It's a plain ROLLING window:
//  - flush `settleMs` (5s) after the LAST message,
//  - every new message RESETS the window to 5s (it never accumulates to 10/15s, and there is no
//    total-time ceiling — a burst is fully compiled no matter how long, then answered once it's
//    been quiet for 5s).

export interface TypingEntry { isTyping: boolean; at: number }
export interface BatchState { lastActivityAt: number }

/**
 * Whether the user is (freshly) typing — used ONLY by the opt-in waitForUserQuiet send-pause, NOT
 * by batching. "Typing" counts as fresh only for one window after the last event, so a stale
 * 'started' with no matching 'stopped' self-expires.
 */
export function isTypingFresh(t: TypingEntry | undefined, now: number, freshMs: number): boolean {
  return !!t?.isTyping && now - t.at < freshMs;
}

/** Flush once it's been quiet for `settleMs` since the last message. Rolling; no ceiling. */
export function shouldFlush(state: BatchState, now: number, settleMs: number): boolean {
  return now - state.lastActivityAt >= settleMs;
}

/**
 * The settle window GROWS with the size of the burst: the more messages someone has fired off, the
 * longer we wait for the next one (they're clearly mid-thought). The Nth queued message uses
 * `baseMs + (N-1)*incrementMs`, capped at `maxMs`. E.g. base 5s, +1s each, max 20s →
 * msg1=5s, msg2=6s, msg3=7s, …, msg16+=20s. Still fully rolling: the chosen window is measured
 * from the LAST message, and it resets (to the new, larger value) on each new one.
 */
export function effectiveSettleMs(messageCount: number, baseMs: number, incrementMs: number, maxMs: number): number {
  const n = Math.max(1, messageCount);
  return Math.min(baseMs + (n - 1) * incrementMs, maxMs);
}
