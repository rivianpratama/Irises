// Rotation-window tests for the engine session id: the UTC window arithmetic (ISO week / calendar
// day), the byte-identical `never` path, and the env parse. Pure — no adapter, no transport.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineSessionId, parseSessionRotation, unknownSessionRotation, SESSION_ROTATIONS, DEFAULT_SESSION_ROTATION } from './engineSession.js';
import { isoWeekParts } from '../../pipeline/isoWeek.js';

/** Instants pinned in UTC — the whole point of the arithmetic is that the host zone cannot move it. */
const WED_2026_09_02 = Date.parse('2026-09-02T12:00:00Z'); // ISO 2026-W36
const SUN_2026_08_30 = Date.parse('2026-08-30T23:59:59Z'); // ISO 2026-W35 — the last second of it
const MON_2026_08_31 = Date.parse('2026-08-31T00:00:00Z'); // ISO 2026-W36 — the first
const FRI_2027_01_01 = Date.parse('2027-01-01T00:00:00Z'); // ISO 2026-W53 (2026 has 53 weeks)
const SUN_2027_01_03 = Date.parse('2027-01-03T23:59:59Z'); // still ISO 2026-W53
const MON_2027_01_04 = Date.parse('2027-01-04T00:00:00Z'); // ISO 2027-W01

test('engineSessionId: `never` returns the id byte-identical — the off path', () => {
  assert.equal(engineSessionId('irises-web-debug', WED_2026_09_02, 'never'), 'irises-web-debug');
  assert.equal(engineSessionId('agent:main:irises-web-debug', MON_2027_01_04, 'never'), 'agent:main:irises-web-debug');
  // Not merely equal-looking: nothing in the instant can reach the output.
  assert.equal(
    engineSessionId('irises-x', 0, 'never'),
    engineSessionId('irises-x', Date.parse('2031-06-06T06:06:06Z'), 'never'),
  );
});

test('engineSessionId: weekly rolls at the ISO-week boundary (Sun→Mon, UTC)', () => {
  assert.equal(engineSessionId('irises-web-debug', SUN_2026_08_30, 'weekly'), 'irises-web-debug-w2026-35');
  assert.equal(engineSessionId('irises-web-debug', MON_2026_08_31, 'weekly'), 'irises-web-debug-w2026-36');
  // One second apart, two sessions — and the Wednesday inside that week shares the Monday's.
  assert.notEqual(
    engineSessionId('irises-web-debug', SUN_2026_08_30, 'weekly'),
    engineSessionId('irises-web-debug', MON_2026_08_31, 'weekly'),
  );
  assert.equal(
    engineSessionId('irises-web-debug', MON_2026_08_31, 'weekly'),
    engineSessionId('irises-web-debug', WED_2026_09_02, 'weekly'),
  );
});

test('engineSessionId: weekly carries the ISO WEEK-NUMBERING year, not the calendar year', () => {
  // 2026 has 53 ISO weeks, so the first three days of January 2027 still belong to 2026-W53. A
  // calendar-year suffix would have rotated the session mid-week, on a Friday.
  assert.equal(engineSessionId('irises-x', FRI_2027_01_01, 'weekly'), 'irises-x-w2026-53');
  assert.equal(engineSessionId('irises-x', SUN_2027_01_03, 'weekly'), 'irises-x-w2026-53');
  assert.equal(engineSessionId('irises-x', MON_2027_01_04, 'weekly'), 'irises-x-w2027-01');
  // …and the mirror case: a December Monday whose week belongs to the NEXT ISO year.
  assert.equal(engineSessionId('irises-x', Date.parse('2025-12-29T00:00:00Z'), 'weekly'), 'irises-x-w2026-01');
  // Weeks are zero-padded to two digits (the repo's other ISO-week rendering does the same), so the
  // suffix has one fixed width all year.
  assert.equal(engineSessionId('irises-x', Date.parse('2026-01-01T00:00:00Z'), 'weekly'), 'irises-x-w2026-01');
});

test('engineSessionId: weekly renders the SHARED ISO week — one arithmetic, two renderings', () => {
  // The window token is `-w<year>-<ww>` of exactly the week `src/pipeline/isoWeek.ts` reports; the
  // thread-ping dedupe key renders the same parts as `<year>-W<ww>`. This is the tie that was
  // missing while each side owned its own copy of the arithmetic: change the shared function and
  // both this file and threadPings.test.ts fail together.
  for (const at of [SUN_2026_08_30, MON_2026_08_31, WED_2026_09_02, FRI_2027_01_01, MON_2027_01_04, Date.parse('2026-04-01T00:00:00Z')]) {
    const { year, week } = isoWeekParts(at);
    assert.equal(engineSessionId('irises-x', at, 'weekly'), `irises-x-w${year}-${String(week).padStart(2, '0')}`, new Date(at).toISOString());
  }
});

test('engineSessionId: daily rolls at UTC midnight', () => {
  assert.equal(engineSessionId('irises-x', WED_2026_09_02, 'daily'), 'irises-x-d20260902');
  assert.equal(engineSessionId('irises-x', Date.parse('2026-09-02T23:59:59Z'), 'daily'), 'irises-x-d20260902');
  assert.equal(engineSessionId('irises-x', Date.parse('2026-09-03T00:00:00Z'), 'daily'), 'irises-x-d20260903');
  // Month/day are padded — a single-digit day must not shorten the token.
  assert.equal(engineSessionId('irises-x', Date.parse('2026-01-05T00:00:00Z'), 'daily'), 'irises-x-d20260105');
});

test('engineSessionId: pure and collision-free across policies', () => {
  const base = 'irises-eng-photon-any----6287879535285';
  const twice = [engineSessionId(base, WED_2026_09_02, 'weekly'), engineSessionId(base, WED_2026_09_02, 'weekly')];
  assert.equal(twice[0], twice[1], 'same inputs, same id — nothing hidden, nothing cached');
  // Every id still starts with the adapter's own stable key, so a session is attributable to its chat.
  for (const policy of SESSION_ROTATIONS) {
    assert.ok(engineSessionId(base, WED_2026_09_02, policy).startsWith(base), `${policy} keeps the base id as its head`);
  }
  const ids = new Set(SESSION_ROTATIONS.map(p => engineSessionId(base, WED_2026_09_02, p)));
  assert.equal(ids.size, SESSION_ROTATIONS.length, 'the three windows can never name the same session');
});

test('parseSessionRotation: default weekly, every member accepted, anything else defaults', () => {
  assert.equal(DEFAULT_SESSION_ROTATION, 'weekly');
  assert.equal(parseSessionRotation(undefined), 'weekly', 'unset → the default');
  assert.equal(parseSessionRotation(''), 'weekly');
  assert.equal(parseSessionRotation('   '), 'weekly');
  for (const policy of SESSION_ROTATIONS) {
    assert.equal(parseSessionRotation(policy), policy);
    assert.equal(parseSessionRotation(` ${policy.toUpperCase()} `), policy, 'trimmed, case-insensitive');
  }
  // An operator typo must not silently disable the rotation — it lands on the documented default.
  assert.equal(parseSessionRotation('week'), 'weekly');
  assert.equal(parseSessionRotation('off'), 'weekly');
});

test('unknownSessionRotation: names the miss the env boundary has to warn about', () => {
  // Unset/empty is not a mistake — it deliberately means the default, so it must stay silent.
  assert.equal(unknownSessionRotation(undefined), null);
  assert.equal(unknownSessionRotation(''), null);
  assert.equal(unknownSessionRotation('   '), null);
  for (const policy of SESSION_ROTATIONS) {
    assert.equal(unknownSessionRotation(policy), null, policy);
    assert.equal(unknownSessionRotation(` ${policy.toUpperCase()} `), null, 'same trim/lower-case as the parse');
  }
  // A miss comes back as the operator wrote it (trimmed), so the warning can quote it back.
  assert.equal(unknownSessionRotation(' Off '), 'Off');
  // The tie: every value the parse silently defaults is a value this reports, so the warning can
  // never disagree with the policy actually used.
  for (const raw of ['off', 'none', 'disabled', 'week', 'monthly', 'weeekly']) {
    assert.equal(parseSessionRotation(raw), DEFAULT_SESSION_ROTATION, raw);
    assert.equal(unknownSessionRotation(raw), raw, raw);
  }
});
