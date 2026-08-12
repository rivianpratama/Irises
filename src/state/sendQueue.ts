// Per-chat outbound serialization. Every user-facing send (live reply, Ops/Judge/Autonome
// follow-up, post-OAuth) acquires this lock so one logical message's bubbles can NEVER be split
// by another's.
//
// Rejection-SAFE by construction: the value stored as the chain head (`link`) is an ALWAYS-resolved
// promise, so a throwing send (sendMessage rejects on a transport error) can never surface as
// an unhandledRejection that takes down the single VM. The caller gets back `run` — the real result,
// which may reject — and is responsible for catching it (fire-and-forget callers add `.catch`).
const sendQueues = new Map<string, Promise<unknown>>();

export function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueues.get(chatId) ?? Promise.resolve();
  const run = prev.then(fn, fn);          // run fn regardless of the previous send's outcome
  const link = run.catch(() => {});       // never-rejecting chain head + cleanup anchor
  sendQueues.set(chatId, link);
  void link.finally(() => { if (sendQueues.get(chatId) === link) sendQueues.delete(chatId); });
  return run;
}

/** Test-only: drop all queue state. */
export function __resetSendQueues(): void {
  sendQueues.clear();
}
