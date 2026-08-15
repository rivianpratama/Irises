// Pin host tz to UTC so the zoned-clock math is proven host-independent (same discipline as
// zonedTime.test.ts) — the slot must come from the PASSED zone, never the host's.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCircadian } from './circadian.js';

// Jan 6 2026 is a Tuesday (weekday); build an instant at hour H UTC.
function atHourUTC(h: number): number {
  return Date.UTC(2026, 0, 6, h, 0, 0);
}

test('slot boundaries in UTC', () => {
  const cases: Array<[number, string]> = [
    [0, 'dead_night'], [4, 'dead_night'],
    [5, 'early_morning'], [8, 'early_morning'],
    [9, 'morning_sharp'], [11, 'morning_sharp'],
    [12, 'afternoon_dip'], [14, 'afternoon_dip'],
    [15, 'afternoon_peak'], [17, 'afternoon_peak'],
    [18, 'evening'], [21, 'evening'],
    [22, 'pre_sleep'], [23, 'pre_sleep'],
  ];
  for (const [h, slot] of cases) {
    assert.equal(computeCircadian(atHourUTC(h), 'UTC').slot, slot, `hour ${h} → ${slot}`);
  }
});

test('the slot follows the PASSED timezone, not the host', () => {
  // 14:30 UTC is simultaneously afternoon in UTC, evening in Jakarta (+7), morning in Chicago (-6 in Jan).
  const instant = Date.UTC(2026, 0, 5, 14, 30, 0);
  assert.equal(computeCircadian(instant, 'UTC').slot, 'afternoon_dip');
  assert.equal(computeCircadian(instant, 'Asia/Jakarta').slot, 'evening');       // 21:30
  assert.equal(computeCircadian(instant, 'America/Chicago').slot, 'early_morning'); // 08:30
});

test('weekend detection uses the zone', () => {
  // 2026-01-10 is a Saturday.
  const sat = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(computeCircadian(sat, 'UTC').weekend, true);
  const tue = Date.UTC(2026, 0, 6, 12, 0, 0);
  assert.equal(computeCircadian(tue, 'UTC').weekend, false);
});

test('energy is bounded 1-100 and a description is present', () => {
  const c = computeCircadian(atHourUTC(16), 'UTC'); // afternoon_peak
  assert.ok(c.energy >= 1 && c.energy <= 100);
  assert.ok(c.description.length > 0);
  // afternoon peak should out-energize the post-lunch dip
  assert.ok(c.energy > computeCircadian(atHourUTC(13), 'UTC').energy);
});

test('a bad timezone falls back without throwing', () => {
  const c = computeCircadian(atHourUTC(10), 'Not/AZone');
  assert.ok(typeof c.slot === 'string');
  assert.ok(c.energy >= 1 && c.energy <= 100);
});
