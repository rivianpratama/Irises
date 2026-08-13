// Per-chat, app-clock log of Irises's assistant sends. ONE entry per sendBubbles delivery — which is
// also one assistant history row (index.ts joins a multi-bubble reply into a single addMessage), so a
// count here lines up with the "run of N" the model sees in its history window.
//
// The one question it answers: did Irises send anything AFTER a given instant? That instant is a
// message's arrival time (PendingMessage.receivedAt), so `countSendsSince(chatId, receivedAt)` is
// "how many of my messages landed after they typed that" — the signal that a queued message is stale
// (it was waiting behind the chat lock while a follow-up delivered, and now predates bubbles it never
// saw when they typed it).
//
// Process-local by design (single VM), mirroring opsCoordination / inboundGlance: the settle queue and
// these timestamps live and die with the process, so there is nothing durable to read. App clock only —
// same app clock the local data layer stamps, so comparisons stay coherent.
//
// This subsumes the old `lastAssistantSentAt` map: `lastSendAt` is exactly that value.

// Keep more than the 40-message history window so a count is never truncated below what the model can
// see; a chat that never stops chatting just keeps the most recent MAX_ENTRIES — counts saturate
// harmlessly (a message older than the oldest kept send is, by definition, deeply stale already).
const MAX_ENTRIES = 50;

const sends = new Map<string, number[]>();

/** Record that Irises sent an assistant message to this chat now (or at `at`). */
export function noteSend(chatId: string, at: number = Date.now()): void {
  const arr = sends.get(chatId);
  if (arr) {
    arr.push(at);
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
  } else {
    sends.set(chatId, [at]);
  }
}

/** How many assistant sends to this chat happened STRICTLY after instant `t`. Full scan (≤MAX_ENTRIES)
 *  so it stays correct regardless of insertion order — it never assumes the log is sorted. */
export function countSendsSince(chatId: string, t: number): number {
  const arr = sends.get(chatId);
  if (!arr) return 0;
  let n = 0;
  for (const s of arr) if (s > t) n++;
  return n;
}

/** When Irises last sent to this chat (epoch ms), or undefined if never. Replaces lastAssistantSentAt. */
export function lastSendAt(chatId: string): number | undefined {
  const arr = sends.get(chatId);
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

/** Test-only: clear all recorded sends. */
export function __resetOutboundLog(): void {
  sends.clear();
}
