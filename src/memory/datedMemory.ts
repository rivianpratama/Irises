// A stored calendar date, answered in code.
//
// Observed live (2026-09-03): "how many days till dana's wedding again" was delegated to the engine
// as deep work, and the answer landed after the sign-off. The date was already in the prompt — it
// was in an important_note she had been asked to remember — and the only missing piece was the
// subtraction. LLMs are unreliable at date arithmetic (chatTime.ts says so at the top and
// precomputes the conversation's own gaps for the same reason), so this precomputes the one other
// place a date reaches the model: the medium tier's notes and facts.
//
// Deterministic, pure, and deliberately timid. It fires only on an unambiguous month-name-plus-day,
// counts whole days between the two dates' NOON in the user's own zone (so a DST day cannot shift
// the count), and otherwise hands the text back untouched. Nothing here parses free text into a
// meaning — a wrong suffix on a note is a false fact in front of the model, so every doubtful case
// declines.
//
// Reuse, not a new dependency: `dateTimeInZone` (pipeline/zonedTime.ts, which chatTime.ts is built
// on) is the repo's tz-correct calendar parser and already rejects impossible dates, and `dayKey`
// (pipeline/chatTime.ts) is how the timing renderer asks which day it is somewhere.

import { dayKey } from '../pipeline/chatTime.js';
import { dateTimeInZone, DEFAULT_TZ } from '../pipeline/zonedTime.js';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A month name (full or the usual abbreviation, with an optional trailing dot), a day of the month
 * with an optional ordinal suffix, and an optional four-digit year.
 *
 * The trailing lookahead is the one false positive worth naming: "he turned 30 in may 5 years ago"
 * is a duration wearing a date's clothes, and it is the shape a person actually writes.
 */
const DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b(?!\s*(?:year|month|week|day|hour|minute)s?\b)/i;

/** Past this many days either way the count stops being an answer and starts being noise — nobody
 *  reads "in 1,830 days". A date with no year can never reach it (the nearest occurrence is at most
 *  half a year away); one with a year can. */
export const DATED_MEMORY_MAX_DAYS = 400;

/** Whole days from today to `ymd`, both read as NOON in `timeZone` so a 23- or 25-hour DST day
 *  cannot round the count off by one. `null` when either date is not a real calendar date, or the
 *  zone is not one Intl knows. */
function daysFromToday(ymd: string, nowMs: number, timeZone: string): number | null {
  try {
    const target = dateTimeInZone(ymd, { hour: 12 }, timeZone);
    const today = dateTimeInZone(dayKey(nowMs, timeZone), { hour: 12 }, timeZone);
    if (!Number.isFinite(target) || !Number.isFinite(today)) return null;
    return Math.round((target - today) / 86_400_000);
  } catch {
    return null; // an unusable agent_tz — the text is better off unannotated than wrong
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** " (in 39 days)" / " (32 days ago)" / " (today)". */
function suffix(days: number): string {
  if (days === 0) return ' (today)';
  const n = Math.abs(days);
  const unit = `${n} day${n === 1 ? '' : 's'}`;
  return days > 0 ? ` (in ${unit})` : ` (${unit} ago)`;
}

/** The first date in one line, dated. '' when there is nothing to date. */
function annotateLine(line: string, nowMs: number, timeZone: string): string {
  const m = DATE_RE.exec(line);
  if (!m) return line;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = Number(m[2]);

  // With a year, that year and no other. Without one, the NEAREST occurrence in either direction —
  // "the january 5 filing" written in September means the coming January, and "the deck came down
  // august 2" means the one that just passed. Guessing forward-only would put a recent past event
  // eleven months in the future, which is a false fact rather than a missing one.
  const years = m[3]
    ? [Number(m[3])]
    : (() => {
        const here = Number(dayKey(nowMs, timeZone).slice(0, 4));
        return Number.isFinite(here) ? [here - 1, here, here + 1] : [];
      })();

  let best: number | null = null;
  for (const year of years) {
    const days = daysFromToday(`${year}-${pad(month)}-${pad(day)}`, nowMs, timeZone);
    if (days === null) continue;
    if (best === null || Math.abs(days) < Math.abs(best)) best = days;
  }
  if (best === null || Math.abs(best) > DATED_MEMORY_MAX_DAYS) return line;
  return `${line.slice(0, m.index + m[0].length)}${suffix(best)}${line.slice(m.index + m[0].length)}`;
}

/**
 * Date every line of a rendered memory payload that carries an unambiguous calendar date, so Convo
 * can answer "how many days till…" from the prompt instead of delegating the subtraction.
 *
 * One date per LINE — the first — because a memory line is one remembered thing and a line with two
 * dates in it is a sentence, not a diary entry. PURE: `nowMs` and the zone are both injected.
 */
export function annotateDates(text: string, nowMs: number, timeZone: string = DEFAULT_TZ): string {
  if (!text) return text;
  try {
    return text.split('\n').map(line => annotateLine(line, nowMs, timeZone)).join('\n');
  } catch {
    return text; // an agent_tz Intl will not accept: no suffix beats a wrong one
  }
}
