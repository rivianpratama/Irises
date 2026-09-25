// What she told them "not now" on, kept so she can come back to it.
//
// Her mood may put off an open-ended ask (research, long writing, a favour with no clock) and say so
// in the envelope (`turned_down: "later: <ask>"`, persona/status.ts). A put-off that nothing
// remembers is a polite way of never doing it, so the ask lands here, rides into the next turns'
// prompt as the `owed` section, and leaves when it is done or stale.
//
// Deliberately small, and stored as one preference row rather than a table: a person has at most a
// few things outstanding with her, the row travels with the rest of their prefs, and nothing here
// needs a query. Three rules, all code:
//   • IN: a `later:` on the envelope. A `no:` is a refusal and owes nothing.
//   • OUT: the ask comes back in their own words (a re-ask settles the old entry, and a second
//     put-off mints a fresh one), or a look she delegated matches it, or she RAISED it (her reply
//     touched it: she always checks whether they still need it before starting, and one check is
//     all it gets, so the entry goes the moment she asks), or it ages past OWED_TTL_MS.
//   • CAP: OWED_MAX, newest kept. A pile of owed favours is a to-do list, and she is not one.
//
// Matching is the same crude token overlap the thread inventory uses (memory/textSim.ts): no model
// call, and a miss costs one stale line that expires on its own.

import { getPreference, setPreference } from '../db/repositories/memory.js';
import { momentAgeWords } from '../persona/moments.js';
import { parseTurnedDown } from '../persona/status.js';
import { tokenSet } from './textSim.js';
import { salientTokens } from './topicality.js';

export interface OwedAsk {
  ask: string;
  at: number;
}

const OWED_KEY = 'owed_asks';

/** At most this many owed at once, newest kept. */
export const OWED_MAX = 3;

/** An owed ask older than this is dropped: four days on, it either got done without her, or it did
 *  not matter, and bringing it up would be her remembering a chore rather than a person. */
export const OWED_TTL_MS = 4 * 24 * 60 * 60 * 1000;

/** How much of the owed ask's words a later text must carry to count as the same ask. */
const SETTLE_CONTAINMENT = 0.6;

/** Heading and lead of the `owed` dyn section. */
export const OWED_HEADING = '## Asks you put off, still owed (INTERNAL)';
export const OWED_LEAD = 'You told them not now on these, and they stayed yours. When your weather is up and the moment fits, bring one back as a check first, one line in your own voice about whether they still need it or it sorted itself out, and start on nothing until they say they do. Once they do, do it, delegated if it needs a look. If the thread already shows it done or answered, leave it. Never list them at them.';

function fresh(items: readonly OwedAsk[], now: number): OwedAsk[] {
  return items.filter(i => typeof i?.ask === 'string' && i.ask && typeof i.at === 'number' && now - i.at <= OWED_TTL_MS && i.at <= now);
}

/** True when `text` carries most of the owed ask's content words (and at least two of them, so a
 *  one-word ask cannot be settled by any message that happens to contain that word). */
export function matchesOwed(ask: string, text: string): boolean {
  const a = tokenSet(ask);
  const b = tokenSet(text);
  if (a.size < 2 || !b.size) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= 2 && shared / a.size >= SETTLE_CONTAINMENT;
}

/** Words too general to prove her reply was about an owed ask ("under 100", "some stuff"). */
const RAISE_FILLER: ReadonlySet<string> = new Set([
  'under', 'over', 'into', 'some', 'thing', 'things', 'stuff', 'need', 'want', 'still', 'again',
  'full', 'best', 'good', 'write', 'research', 'look', 'find', 'make', 'help', 'with', 'from',
]);

/**
 * Did her reply bring this owed ask back up? Looser than `matchesOwed` on purpose: her check is one
 * short line in her own words ("still need the keyboard thing?"), so one shared topic word is the
 * whole signal. A false yes costs one owed ask she forgets; a false no would have her ask twice,
 * which is the nagging the one-check rule exists to prevent.
 */
export function raisesOwed(ask: string, reply: string): boolean {
  if (!reply.trim()) return false;
  const words = (t: string) => new Set([...salientTokens(t)].filter(w => w.length >= 4 && /^[a-z]+$/.test(w) && !RAISE_FILLER.has(w)));
  const a = words(ask);
  const b = words(reply);
  for (const w of a) if (b.has(w)) return true;
  return false;
}

/** The owed asks still live for this person, oldest first. */
export async function readOwedAsks(handle: string, now: number = Date.now()): Promise<OwedAsk[]> {
  const raw = await getPreference<OwedAsk[]>(handle, OWED_KEY);
  return Array.isArray(raw) ? fresh(raw, now) : [];
}

/**
 * The pure fold, one turn's worth: settle what this turn's texts match or her reply raised, then add
 * this turn's put-off. Settling runs first so a re-ask that she puts off AGAIN leaves exactly one
 * fresh entry, and so the not-now reply that mints an entry can never be read as raising it.
 */
export function foldOwedAsks(
  items: readonly OwedAsk[],
  turn: { texts: readonly string[]; turnedDown?: string; raised?: string },
  now: number,
): OwedAsk[] {
  const texts = turn.texts.filter(t => typeof t === 'string' && t.trim());
  const raised = turn.raised ?? '';
  let next = fresh(items, now).filter(i => !texts.some(t => matchesOwed(i.ask, t)) && !raisesOwed(i.ask, raised));
  const down = parseTurnedDown(turn.turnedDown);
  if (down?.how === 'later') {
    next = next.filter(i => !matchesOwed(i.ask, down.ask));
    next.push({ ask: down.ask, at: now });
  }
  return next.slice(-OWED_MAX);
}

/**
 * The turn's write: `recordOwedAsk` is the envelope consumer name (persona/status.ts). Writes only
 * when something changed, so an ordinary turn costs one pref read and nothing else. Never throws: a
 * lost owed ask is one thing she forgets, which is also what people do.
 */
export async function recordOwedAsk(
  handle: string,
  turn: { texts: readonly string[]; turnedDown?: string; raised?: string },
  now: number = Date.now(),
): Promise<void> {
  try {
    const raw = await getPreference<OwedAsk[]>(handle, OWED_KEY);
    const before = Array.isArray(raw) ? raw : [];
    if (!before.length && !parseTurnedDown(turn.turnedDown)) return;
    const next = foldOwedAsks(before, turn, now);
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    await setPreference(handle, OWED_KEY, next);
  } catch (err) {
    console.warn('[owed] could not update owed asks:', err instanceof Error ? err.message : err);
  }
}

/** The `owed` dyn section, or '' when nothing is owed. Ages in words, never digits. */
export function renderOwedSection(items: readonly OwedAsk[], now: number): string {
  if (!items.length) return '';
  return [OWED_HEADING, OWED_LEAD, ...items.map(i => `- ${i.ask} (${momentAgeWords(i.at, now)})`)].join('\n');
}
