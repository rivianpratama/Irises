import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, describeDateVsToday, describeAgeDays, overdueDays } from './dateAge.js';

const NOW = Date.parse('2026-08-01T00:00:00Z');

test('daysBetween: positive past, negative future, null on unparseable/absent', () => {
  assert.equal(daysBetween('2026-07-31', NOW), 1);
  assert.equal(daysBetween('2026-08-08', NOW), -7);
  assert.equal(daysBetween('2026-08-01', NOW), 0);
  assert.equal(daysBetween('not-a-date', NOW), null);
  assert.equal(daysBetween(null, NOW), null);
});

test('describeDateVsToday: today / in Nd / Nd past', () => {
  assert.equal(describeDateVsToday('2026-08-01', NOW), 'today');
  assert.equal(describeDateVsToday('2026-07-07', NOW), '25d past');
  assert.equal(describeDateVsToday('2026-07-31', NOW), '1d past');
  assert.equal(describeDateVsToday('2026-08-08', NOW), 'in 7d');
  assert.equal(describeDateVsToday(null, NOW), null);
});

test('describeDateVsToday: a date-only target compares in the USER tz, not UTC (evening-boundary)', () => {
  // 8pm Chicago on 2026-08-01 = 2026-08-02T01:00Z. A target date of 2026-08-02 is TOMORROW locally.
  const chicagoEvening = Date.parse('2026-08-02T01:00:00Z');
  assert.equal(describeDateVsToday('2026-08-02', chicagoEvening, 'America/Chicago'), 'in 1d', 'must read local calendar date, not UTC');
  // Without a tz it falls back to UTC (where it is already Aug 2) → "today".
  assert.equal(describeDateVsToday('2026-08-02', chicagoEvening), 'today');
});

test('describeAgeDays: today for now/future, Nd ago for past, null if absent', () => {
  assert.equal(describeAgeDays('2026-07-01', NOW), '31d ago');
  assert.equal(describeAgeDays('2026-08-01', NOW), 'today');
  assert.equal(describeAgeDays('2026-08-05', NOW), 'today'); // future activity clamps to today
  assert.equal(describeAgeDays(null, NOW), null);
});

test('overdueDays: whole days overdue, else null', () => {
  assert.equal(overdueDays('2026-07-08', NOW), 24);
  assert.equal(overdueDays('2026-08-08', NOW), null); // future
  assert.equal(overdueDays('2026-08-01', NOW), null); // today, not overdue
  assert.equal(overdueDays(null, NOW), null);
});
