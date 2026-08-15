import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCycle, cycleDay, phaseForDay } from './cycle.js';

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 0, 1); // day 1

test('cycleDay counts whole days from the anchor, 1-28, wrapping at 28', () => {
  assert.equal(cycleDay(ANCHOR, ANCHOR), 1);
  assert.equal(cycleDay(ANCHOR + 4 * DAY, ANCHOR), 5);
  assert.equal(cycleDay(ANCHOR + 13 * DAY, ANCHOR), 14);
  assert.equal(cycleDay(ANCHOR + 27 * DAY, ANCHOR), 28);
  assert.equal(cycleDay(ANCHOR + 28 * DAY, ANCHOR), 1); // wraps
  // a fractional day still floors to the same cycle day
  assert.equal(cycleDay(ANCHOR + 5 * DAY + DAY / 2, ANCHOR), 6);
});

test('cycleDay stays 1-28 for instants BEFORE the anchor', () => {
  assert.equal(cycleDay(ANCHOR - DAY, ANCHOR), 28);
  assert.equal(cycleDay(ANCHOR - 28 * DAY, ANCHOR), 1);
});

test('phaseForDay maps the four phases at their boundaries', () => {
  assert.equal(phaseForDay(1), 'menstrual');
  assert.equal(phaseForDay(5), 'menstrual');
  assert.equal(phaseForDay(6), 'follicular');
  assert.equal(phaseForDay(13), 'follicular');
  assert.equal(phaseForDay(14), 'ovulation');
  assert.equal(phaseForDay(15), 'luteal');
  assert.equal(phaseForDay(28), 'luteal');
});

test('computeCycle returns phase + day + a bounded load + a description', () => {
  const menstrual = computeCycle(ANCHOR, ANCHOR);
  assert.equal(menstrual.phase, 'menstrual');
  assert.equal(menstrual.day, 1);
  assert.ok(menstrual.load >= 1 && menstrual.load <= 100);
  assert.ok(menstrual.description.length > 0);

  const ovulation = computeCycle(ANCHOR + 13 * DAY, ANCHOR);
  assert.equal(ovulation.phase, 'ovulation');
  // ovulation is the lowest-pull window; menstrual + late-luteal are the hardest
  assert.ok(ovulation.load < menstrual.load);

  const lateLuteal = computeCycle(ANCHOR + 27 * DAY, ANCHOR); // day 28
  assert.equal(lateLuteal.phase, 'luteal');
  assert.ok(lateLuteal.load > ovulation.load);
});

test('luteal load ramps from early to late', () => {
  const early = computeCycle(ANCHOR + 14 * DAY, ANCHOR); // day 15
  const late = computeCycle(ANCHOR + 27 * DAY, ANCHOR);  // day 28
  assert.ok(late.load > early.load);
});
