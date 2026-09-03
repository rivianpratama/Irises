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
// declines. Three things are doubtful and all three decline: a line another renderer already cut
// (the cut can take half a day or half a year and leave a date that still parses), a yearless date
// more than YEARLESS_MAX_DAYS off in the direction its own sentence points, and anything that is not
// a real calendar day.
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
 *  reads "in 1,830 days". Only a date that states its own year can reach it. */
export const DATED_MEMORY_MAX_DAYS = 400;

/** …and a date with NO year gets a much shorter rope. Its two candidate occurrences are a year
 *  apart, so half a year out they are equally close and the suffix stops being a count and becomes a
 *  guess about which year they meant. */
export const YEARLESS_MAX_DAYS = 180;

/**
 * Does the sentence in front of the date say the thing already happened?
 *
 * Deliberately over-eager, and deliberately one-directional: a cue can only ever move the read
 * BACKWARD, onto the occurrence that has already been, and a backward occurrence nearly a year away
 * declines on YEARLESS_MAX_DAYS. So a false positive costs at most a suffix — while the false
 * negative is the failure this exists to stop: "mom's surgery was january 8", read as the nearest
 * occurrence, counts forward to next january and announces a finished operation as a plan.
 *
 * Regular past tense is any -ed word with a real stem in front of it; the rest are the irregulars a
 * person actually writes in a note about their own life.
 */
const PAST_CUE_RE = /\b(?:ago|last|since|back in|was|were|had|did|went|came|got|took|gave|made|saw|told|said|left|sent|met|broke|bought|sold|fell|lost|spent|wrote|won|began|held|kept|ran|[a-z]{3,}ed)\b/i;

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

/** The mark a caller leaves when it shortened a line to fit — memory/wrappers.ts clip() and
 *  clipSection() both end a cut line with it. */
const CLIPPED_MARK = '…';

/** The first date in one line, dated. The line back unchanged when there is nothing to date. */
function annotateLine(line: string, nowMs: number, timeZone: string): string {
  // A line somebody already CUT is not a line this can read. The medium gate stands an off-topic
  // note in as an 80-character digest and cuts at the character, not at a token: land the cut inside
  // the day and "october 12" is "october 1" — a real date, eleven days off what the note says — and
  // land it inside the year and "october 12, 2027" is "october 12, 202", which parses as a yearless
  // october 12. Both are confident parses of text the user never wrote, and the suffix would go in
  // BEFORE the ellipsis, so nothing in the prompt would even say the line was cut. So: a visibly
  // clipped line carries no count. The full text of the same note (a note that touches the turn
  // rides whole) still does.
  if (line.trimEnd().endsWith(CLIPPED_MARK)) return line;

  const m = DATE_RE.exec(line);
  if (!m) return line;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = Number(m[2]);
  const daysTo = (year: number) => daysFromToday(`${year}-${pad(month)}-${pad(day)}`, nowMs, timeZone);

  let best: number | null = null;
  let limit = DATED_MEMORY_MAX_DAYS;
  if (m[3]) {
    // A year of their own: that year and no other, whichever way it falls.
    best = daysTo(Number(m[3]));
  } else {
    // No year, so the sentence around the date is the only evidence for which occurrence they meant.
    // Past tense means the one that has already been — "the deck came down august 2" is the august
    // that just passed, never the one eleven months out. Anything else takes the NEAREST occurrence
    // either way, which is what a note like "the january 5 filing" or "renewal on sept 4th" means.
    // Then the short rope: a yearless date more than half a year off in the direction the sentence
    // points is a guess about the year, and it declines.
    const here = Number(dayKey(nowMs, timeZone).slice(0, 4));
    if (!Number.isFinite(here)) return line;
    const occurrences = [here - 1, here, here + 1]
      .map(daysTo)
      .filter((days): days is number => days !== null);
    const pool = PAST_CUE_RE.test(line.slice(0, m.index)) ? occurrences.filter(d => d <= 0) : occurrences;
    for (const days of pool) if (best === null || Math.abs(days) < Math.abs(best)) best = days;
    limit = YEARLESS_MAX_DAYS;
  }
  if (best === null || Math.abs(best) > limit) return line;
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
