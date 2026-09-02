// ISO-8601 week numbering of a UTC instant — the repo's ONE home for that arithmetic.
//
// Two features need "which week is it right now", and they render it differently:
//   • the thread-revisit ping's dedupe key   → `2026-W14`   (src/memory/threadPings.ts)
//   • the engine session's rotation window   → `-w2026-14`  (src/agents/ops/engineSession.ts)
// They each owned a copy of the nine statements below, byte-identical apart from a constant's name,
// with nothing in either test file relating the two. That is a divergence waiting to happen: a fix
// to one copy (a padding change, a boundary correction) leaves the other silently spelling a
// different week while both suites stay green. So the arithmetic lives here once and the callers
// only choose how to write it down.
//
// ZERO imports on purpose: a pure leaf that src/memory, src/agents and src/pipeline can all take
// without dragging a dependency tail in behind it (`threadPings.ts` avoids src/pipeline precisely
// because most of it reaches back into src/agents — this file reaches nowhere).

const DAY_MS = 86_400_000;

/** An ISO-8601 week: the WEEK-NUMBERING year (not the calendar year) and the week within it. */
export interface IsoWeekParts {
  /** The year the week belongs to — 2027-01-01 answers 2026, because 2026 has 53 ISO weeks. */
  year: number;
  /** 1…53, unpadded. Callers that render a fixed-width token pad it themselves. */
  week: number;
}

/**
 * The ISO-8601 week containing a UTC instant.
 *
 * UTC on purpose, for both callers: a week boundary must be the same instant everywhere, and a
 * token that moved with the host's zone would roll twice (or not at all) around a zone change.
 *
 * ISO weeks are Monday-based and belong to the year of their Thursday — which is why the answer is
 * a week-numbering year rather than `getUTCFullYear()`: for the engine session that difference is a
 * transcript rotating mid-week on a Friday, and for the ping dedupe key it is two keys inside one
 * week. Pure: the instant is the only input.
 */
export function isoWeekParts(at: number): IsoWeekParts {
  const d = new Date(at);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const mondayIndex = (new Date(midnight).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thursday = midnight + (3 - mondayIndex) * DAY_MS;       // the week's Thursday owns its year
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);                            // always in ISO week 1
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.round((thursday - week1Monday) / (7 * DAY_MS)) + 1;
  return { year, week };
}
