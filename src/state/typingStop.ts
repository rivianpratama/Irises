// Typing-indicator LIFECYCLE: the bookkeeping that guarantees a reply ends with the dots OFF.
// Pure and dependency-injected (same shape as pacing.ts holdLoop) so the timing rules below can be
// asserted against a fake clock instead of a real 4.5-second wait.
//
// Why this exists at all. The send path treats "start typing" as fire-and-forget — a ping every
// couple of seconds through withTypingKeptAlive, one more before each paced bubble — because
// AWAITING them once stacked a full HTTP round trip onto every hold. That is correct for the web
// channel, where the browser hides the dots the moment any bubble lands, so no explicit stop is ever
// needed. It is WRONG for Photon over the Hermes bridge: that indicator is STATEFUL —
// setTyping(guid, true) stays lit until setTyping(guid, false) — so a reply that never sends a stop
// leaves the dots burning forever, reading as "she's still typing" long after she finished.
//
// Why the TRAILING stop, and not just one stop after the last bubble. Those starts are unordered
// with respect to everything else: the gateway leg routinely takes seconds (both sides time out at
// 3s), so a start issued a beat BEFORE the final send can execute AFTER the immediate stop that
// follows it — re-lighting the indicator with nothing left to deliver, and nothing behind it to
// clear it again. So a release stops twice: now, and once more after `trailingStopMs` (which must
// exceed that 3s round-trip ceiling), by which time any start still in flight has landed and can be
// stomped.
//
// Why the trailing stop is GUARDED. Between the release and the trailing timer a genuinely new turn
// can begin and assert fresh dots (the mouth's voicer case does exactly this: keepTypingAlive
// releases on settle, then sendBubbles re-starts for the first bubble). Firing a blind second stop
// there would blank the indicator on a reply that really is still coming. So the trailing stop fires
// only if no start was recorded for that chat AFTER the release — which is why every start in the
// send path must go through noteStart, not straight to the channel.

export interface TypingLifecycleDeps {
  now: () => number;
  /** Fire-and-forget channel start. Must NOT return an awaited promise — see the header. */
  start: (chatId: string) => void;
  /** Fire-and-forget channel stop. */
  stop: (chatId: string) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface TypingLifecycle {
  /** Record + assert "typing" for this chat. Every start in the send path routes through here. */
  noteStart(chatId: string): void;
  /** The reply is over: stop the dots now, and again after the trailing window (guarded). */
  release(chatId: string): void;
}

export function createTypingLifecycle(deps: TypingLifecycleDeps, opts: { trailingStopMs: number }): TypingLifecycle {
  // When each chat last ASSERTED dots, and its one pending trailing timer. Both are bounded by
  // deleting the chat's entries when its trailing stop actually fires (below) — a process that talks
  // to thousands of chats over its life holds entries only for the ones mid-turn.
  const lastStartAt = new Map<string, number>();
  const trailing = new Map<string, unknown>();

  return {
    noteStart(chatId: string): void {
      lastStartAt.set(chatId, deps.now());
      deps.start(chatId);
    },

    release(chatId: string): void {
      const stopAt = deps.now();
      deps.stop(chatId);
      // At most ONE trailing timer per chat: a second release (sendBubbles then the keep-alive
      // finally, or two deliveries in a row) reschedules rather than stacking stops that would each
      // fire blind at their own deadline.
      const pending = trailing.get(chatId);
      if (pending !== undefined) {
        deps.clearTimeout(pending);
        trailing.delete(chatId);
      }
      const handle = deps.setTimeout(() => {
        trailing.delete(chatId);
        const startedAt = lastStartAt.get(chatId);
        // A start STRICTLY after this release means a new turn owns the dots now — leave them lit;
        // that turn's own release will clear them. A start at the same instant was already covered
        // by this release, so the trailing stop stays armed.
        if (startedAt !== undefined && startedAt > stopAt) return;
        lastStartAt.delete(chatId);
        deps.stop(chatId);
      }, opts.trailingStopMs);
      trailing.set(chatId, handle);
    },
  };
}
