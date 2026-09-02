// The repo's ONE ISO-week arithmetic, tested against the standard's own worked examples.
//
// Two callers render this: the thread-ping dedupe key (`2026-W14`, src/memory/threadPings.ts) and
// the engine session window (`-w2026-14`, src/agents/ops/engineSession.ts). They used to own a copy
// each — nine byte-identical statements of date math with nothing tying them together, so a fix to
// one would have left the other spelling a different week. This file is where the arithmetic itself
// is pinned; each caller's own tests pin its rendering on top of it.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekParts } from './isoWeek.js';

/** `<week-numbering-year>-W<2-digit week>` — only for reading the assertions below. */
function label(at: number): string {
  const { year, week } = isoWeekParts(at);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

test('isoWeekParts: the ISO-8601 standard’s own worked examples', () => {
  // Straight off the ISO week-date reference table — the cases where the week-numbering year is NOT
  // the calendar year, which is the whole reason this is not a one-liner.
  const table: Array<[string, string]> = [
    ['1970-01-01', '1970-W01'],
    ['1977-01-01', '1976-W53'], // a January day owned by the previous ISO year
    ['1977-01-02', '1976-W53'],
    ['1977-12-31', '1977-W52'],
    ['1978-01-01', '1977-W52'],
    ['1978-01-02', '1978-W01'],
    ['1979-12-30', '1979-W52'],
    ['1979-12-31', '1980-W01'], // a December day owned by the NEXT ISO year
    ['1980-01-01', '1980-W01'],
    ['1980-12-28', '1980-W52'],
    ['1980-12-29', '1981-W01'],
    ['1981-01-01', '1981-W01'],
    ['1981-12-31', '1981-W53'], // 1981 is a 53-week year
    ['1982-01-01', '1981-W53'],
    ['2000-01-01', '1999-W52'],
    ['2020-01-01', '2020-W01'],
  ];
  for (const [day, expected] of table) {
    assert.equal(label(Date.parse(`${day}T00:00:00Z`)), expected, day);
  }
});

test('isoWeekParts: the week rolls at Monday 00:00 UTC and nowhere else inside the day', () => {
  // One second apart, two weeks: 2026-08-30 is a Sunday (the last day of 2026-W35).
  assert.deepEqual(isoWeekParts(Date.parse('2026-08-30T23:59:59Z')), { year: 2026, week: 35 });
  assert.deepEqual(isoWeekParts(Date.parse('2026-08-31T00:00:00Z')), { year: 2026, week: 36 });
  // …and every instant inside a UTC day is the same week, so the boundary is the day, not the hour.
  for (const t of ['00:00:00', '06:30:00', '12:00:00', '23:59:59.999']) {
    assert.deepEqual(isoWeekParts(Date.parse(`2026-09-02T${t}Z`)), { year: 2026, week: 36 }, t);
  }
});

test('isoWeekParts: 53-week years, in both directions', () => {
  // 2026 has 53 ISO weeks, so the first three days of January 2027 still belong to 2026-W53 — and a
  // late-December Monday belongs to the next ISO year.
  assert.deepEqual(isoWeekParts(Date.parse('2027-01-01T00:00:00Z')), { year: 2026, week: 53 });
  assert.deepEqual(isoWeekParts(Date.parse('2027-01-03T23:59:59Z')), { year: 2026, week: 53 });
  assert.deepEqual(isoWeekParts(Date.parse('2027-01-04T00:00:00Z')), { year: 2027, week: 1 });
  assert.deepEqual(isoWeekParts(Date.parse('2025-12-29T00:00:00Z')), { year: 2026, week: 1 });
  // The parts are numbers, unpadded: padding is each caller's rendering choice, not the arithmetic's.
  assert.equal(isoWeekParts(Date.parse('2026-01-01T00:00:00Z')).week, 1);
});

test('isoWeekParts: pure — same instant, same parts, nothing cached', () => {
  const at = Date.parse('2026-04-01T09:15:00Z'); // the thread-ping fixture's clock: 2026-W14
  assert.deepEqual(isoWeekParts(at), isoWeekParts(at));
  assert.deepEqual(isoWeekParts(at), { year: 2026, week: 14 });
});
