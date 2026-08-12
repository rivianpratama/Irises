// Run with: npm test   (TZ=UTC tsx --test)
// We pin the host timezone to UTC — the exact deployment condition that broke the old
// `Date.parse(`${date}T17:00:00`)` approach — to prove the helper is host-tz-independent.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeInZone, zonedTimeToUtcMs, DEFAULT_TZ } from './zonedTime.js';

const iso = (ms: number) => new Date(ms).toISOString();

test('5pm America/Chicago in summer maps to the correct UTC instant (CDT, UTC-5)', () => {
  // The headline case from the bug report.
  assert.equal(iso(dateTimeInZone('2026-07-10', { hour: 17 })), '2026-07-10T22:00:00.000Z');
});

test('5pm America/Chicago in winter maps to the correct UTC instant (CST, UTC-6)', () => {
  assert.equal(iso(dateTimeInZone('2026-01-10', { hour: 17 })), '2026-01-10T23:00:00.000Z');
});

test('5pm is DST-correct on both transition days', () => {
  // Spring-forward day: by 5pm clocks are already on CDT (UTC-5).
  assert.equal(iso(dateTimeInZone('2026-03-08', { hour: 17 })), '2026-03-08T22:00:00.000Z');
  // Fall-back day: by 5pm clocks are back on CST (UTC-6).
  assert.equal(iso(dateTimeInZone('2026-11-01', { hour: 17 })), '2026-11-01T23:00:00.000Z');
});

test('the timezone argument is honored (America/New_York, EDT UTC-4)', () => {
  assert.equal(iso(dateTimeInZone('2026-07-10', { hour: 17 }, 'America/New_York')), '2026-07-10T21:00:00.000Z');
});

test('minutes and seconds are respected', () => {
  assert.equal(iso(dateTimeInZone('2026-07-10', { hour: 9, minute: 30, second: 15 })), '2026-07-10T14:30:15.000Z');
});

test('default timezone is America/Chicago', () => {
  assert.equal(DEFAULT_TZ, 'America/Chicago');
  assert.equal(
    dateTimeInZone('2026-07-10', { hour: 17 }),
    dateTimeInZone('2026-07-10', { hour: 17 }, 'America/Chicago'),
  );
});

test('malformed or non-existent dates return NaN (so callers skip them)', () => {
  assert.ok(Number.isNaN(dateTimeInZone('not-a-date', { hour: 17 })));
  assert.ok(Number.isNaN(dateTimeInZone('2026-13-01', { hour: 17 }))); // month 13
  assert.ok(Number.isNaN(dateTimeInZone('2026-02-30', { hour: 17 }))); // Feb 30 never exists
  assert.ok(Number.isNaN(dateTimeInZone('2026-07-10T17:00:00', { hour: 17 }))); // not bare YYYY-MM-DD
});

test('zonedTimeToUtcMs core handles components directly', () => {
  assert.equal(
    iso(zonedTimeToUtcMs({ year: 2026, month: 7, day: 10, hour: 17 }, 'America/Chicago')),
    '2026-07-10T22:00:00.000Z',
  );
});

test('regression: the old host-local parse is wrong under TZ=UTC, the helper is not', () => {
  // What the buggy code did: parse a tz-less string in the host zone (here UTC).
  const oldHostLocal = Date.parse('2026-07-10T17:00:00');
  assert.equal(iso(oldHostLocal), '2026-07-10T17:00:00.000Z'); // 5pm UTC ≈ noon Chicago — 5h off
  // The fix anchors to Chicago regardless of host tz.
  assert.equal(iso(dateTimeInZone('2026-07-10', { hour: 17 })), '2026-07-10T22:00:00.000Z');
  assert.notEqual(dateTimeInZone('2026-07-10', { hour: 17 }), oldHostLocal);
});
