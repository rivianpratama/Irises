// Run with: npm test   (TZ=UTC tsx --test)
// We pin the host timezone to UTC — the exact deployment condition that broke the old
// `Date.parse(`${date}T17:00:00`)` approach — to prove the helper is host-tz-independent.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dateTimeInZone, zonedTimeToUtcMs, DEFAULT_TZ,
  inQuietHours, nextQuietHoursEndMs, zoneOffsetMs, QUIET_START_HOUR, QUIET_END_HOUR,
} from './zonedTime.js';

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

// ── quiet hours (the proactive deferral window) ────────────────────────────────────────────────

test('quiet hours are 9pm–8am in the USER\'s zone, not the host\'s', () => {
  assert.equal(QUIET_START_HOUR, 21);
  assert.equal(QUIET_END_HOUR, 8);
  // The zone is what decides: 12:00Z is midday in UTC but 21:00 in Tokyo — quiet there, not here.
  assert.equal(inQuietHours('Asia/Tokyo', Date.parse('2026-07-10T12:00:00Z')), true);
  assert.equal(inQuietHours('UTC', Date.parse('2026-07-10T12:00:00Z')), false);
  // 07:00Z is 02:00 in Chicago (CDT) — the small hours.
  assert.equal(inQuietHours('America/Chicago', Date.parse('2026-07-10T07:00:00Z')), true);
  // 03:00Z is 22:00 the PREVIOUS day in Chicago — the evening half of the window.
  assert.equal(inQuietHours('America/Chicago', Date.parse('2026-07-10T03:00:00Z')), true);
  assert.equal(inQuietHours('America/Chicago', Date.parse('2026-07-10T17:00:00Z')), false); // noon local
});

test('nextQuietHoursEndMs: a 2am arrival waits for this morning', () => {
  const at2am = Date.parse('2026-07-10T07:00:00Z'); // 02:00 CDT
  assert.equal(iso(nextQuietHoursEndMs('America/Chicago', at2am)), '2026-07-10T13:00:00.000Z'); // 08:00 CDT
});

test('nextQuietHoursEndMs: a 10pm arrival waits for tomorrow morning', () => {
  const at10pm = Date.parse('2026-07-10T03:00:00Z'); // 22:00 CDT on the 9th
  // The zone's own calendar day is the 9th, so its "tomorrow 8am" is the 10th at 13:00Z.
  assert.equal(iso(nextQuietHoursEndMs('America/Chicago', at10pm)), '2026-07-10T13:00:00.000Z');
});

test('nextQuietHoursEndMs: outside quiet hours it returns now (deferring is a no-op)', () => {
  const noon = Date.parse('2026-07-10T17:00:00Z');
  assert.equal(nextQuietHoursEndMs('America/Chicago', noon), noon);
});

test('nextQuietHoursEndMs is DST-correct across the spring-forward night', () => {
  // 01:00 CST on spring-forward day (still UTC-6); by 8am the zone is on CDT (UTC-5), so the
  // target is 13:00Z. Adding 7 hours to "now" would land an hour late, at 14:00Z.
  const at1am = Date.parse('2026-03-08T07:00:00Z');
  assert.equal(iso(nextQuietHoursEndMs('America/Chicago', at1am)), '2026-03-08T13:00:00.000Z');
  // Fall-back night: 01:00 CDT → 8am is CST (UTC-6) → 14:00Z.
  const fall = Date.parse('2026-11-01T05:30:00Z'); // 00:30 CDT
  assert.equal(iso(nextQuietHoursEndMs('America/Chicago', fall)), '2026-11-01T14:00:00.000Z');
});

test('nextQuietHoursEndMs: a bogus zone degrades to now instead of throwing', () => {
  const now = Date.parse('2026-07-10T07:00:00Z');
  assert.equal(nextQuietHoursEndMs('Not/AZone', now), now);
});

test('zoneOffsetMs reports the zone offset at an instant, DST-aware', () => {
  assert.equal(zoneOffsetMs('UTC', Date.parse('2026-07-10T12:00:00Z')), 0);
  assert.equal(zoneOffsetMs('America/Chicago', Date.parse('2026-07-10T12:00:00Z')), -5 * 3600_000); // CDT
  assert.equal(zoneOffsetMs('America/Chicago', Date.parse('2026-01-10T12:00:00Z')), -6 * 3600_000); // CST
  assert.equal(zoneOffsetMs('Asia/Kolkata', Date.parse('2026-07-10T12:00:00Z')), 5.5 * 3600_000);
});

test('regression: the old host-local parse is wrong under TZ=UTC, the helper is not', () => {
  // What the buggy code did: parse a tz-less string in the host zone (here UTC).
  const oldHostLocal = Date.parse('2026-07-10T17:00:00');
  assert.equal(iso(oldHostLocal), '2026-07-10T17:00:00.000Z'); // 5pm UTC ≈ noon Chicago — 5h off
  // The fix anchors to Chicago regardless of host tz.
  assert.equal(iso(dateTimeInZone('2026-07-10', { hour: 17 })), '2026-07-10T22:00:00.000Z');
  assert.notEqual(dateTimeInZone('2026-07-10', { hour: 17 }), oldHostLocal);
});
