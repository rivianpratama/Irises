// A short per-chat memory of Irises's last few holding beats — the "one sec, looking that up"
// line she sends while a delegated lookup is in flight. Later work uses this history to steer
// her away from repeating the same beat twice in a row. Keyed by chatId (not the sender handle):
// the beat history belongs to the conversation itself, so two chats with the same person keep
// separate histories, mirroring how recent_media scopes recall to one chatId.

import { getPreference, setPreference } from '../db/repositories/memory.js';

const HOLDING_BEATS_PREF = 'holding_beats_recent';

/** How many recent beats we keep — enough to dodge an immediate repeat without the history
 *  ever needing pruning logic beyond "drop the oldest". */
export const HOLDING_BEATS_KEPT = 5;

/** Append `beat`, moving an exact duplicate to the end instead of storing it twice, and drop the
 *  oldest entry once the list grows past HOLDING_BEATS_KEPT. Pure so the cap/dedup rules are
 *  unit-testable without touching the preference store. */
export function pushHoldingBeat(prev: readonly string[], beat: string): string[] {
  const deduped = prev.filter(b => b !== beat);
  const next = [...deduped, beat];
  return next.length > HOLDING_BEATS_KEPT ? next.slice(next.length - HOLDING_BEATS_KEPT) : next;
}

/** The chat's recent holding beats, oldest first. [] when there's no history yet, or the stored
 *  value isn't a string array (a corrupt/foreign pref is not worth failing the turn over) — same
 *  shape-guard as listDirectives for an array-shaped preference. */
export async function recentHoldingBeats(chatId: string): Promise<string[]> {
  const raw = await getPreference<unknown>(chatId, HOLDING_BEATS_PREF);
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is string => typeof b === 'string');
}

/** Read → push → write, so callers don't have to juggle the round trip themselves. */
export async function recordHoldingBeat(chatId: string, beat: string): Promise<void> {
  const prev = await recentHoldingBeats(chatId);
  await setPreference(chatId, HOLDING_BEATS_PREF, pushHoldingBeat(prev, beat));
}
