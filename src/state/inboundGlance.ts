// A read-only glance at user messages that have ARRIVED but not yet entered conversation history.
// Two places hold such messages: the burst batcher's settle queue (index.ts pendingChats), and the
// batch currently being processed (spliced out of the queue, its turn not yet through addMessage).
// Out-of-band voicers — chiefly the Composer's late Ops reply — read HISTORY, which contains
// neither, so without this glance they would compose as if those texts don't exist and visibly
// "jump the convo" (answer an old question while a newer text sits unacknowledged on screen).
//
// index.ts registers the provider once at boot; voicers peek through it. In-memory and
// process-local by design (single VM), mirroring opsCoordination — the queue itself lives and dies
// with the process, so there is nothing durable to read.
type PendingProvider = (chatId: string) => string[];

let provider: PendingProvider | null = null;

export function registerPendingInboundProvider(fn: PendingProvider): void {
  provider = fn;
}

/** Raw texts of not-yet-answered inbound messages for this chat, oldest first. Never throws —
 *  a glance is best-effort context, and a provider bug must not take down a delivery. */
export function peekPendingInbound(chatId: string): string[] {
  try {
    return provider?.(chatId) ?? [];
  } catch {
    return [];
  }
}

/**
 * The subset of pending texts a voicer should actually nod to: ones NOT already visible in the
 * history window it was handed. A batch mid-processing may have recorded its (enriched, possibly
 * burst-merged) user turn already — its raw texts appear as substrings of that record, so they're
 * "seen" and nodding to them again would double-count. Pure, unit-tested.
 */
export function selectUnseenPending(
  pending: string[],
  history: { role: string; content: string }[],
): string[] {
  const userTurns = history.filter(m => m.role === 'user').map(m => m.content);
  return pending
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => !userTurns.some(content => content.includes(t)));
}

/** Test-only: drop the registered provider. */
export function __resetPendingInboundProvider(): void {
  provider = null;
}
