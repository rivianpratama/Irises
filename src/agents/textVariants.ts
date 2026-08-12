// Shared helper for the instant, no-latency reassurance copy (holding lines, progress pings,
// heartbeats — see fallfirm/floor.ts and ops/client.ts). These fire without a model call because
// the whole point is speed, so they can't be voiced fresh by an LLM each time. Instead each spot
// keeps a small pool of hand-written variants and picks one here, so the same line doesn't repeat
// verbatim across a conversation.

/** Pick a pseudo-random entry from a pool of pre-written phrasings. */
export function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}
