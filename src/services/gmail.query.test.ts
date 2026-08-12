// Run with: npm test   (TZ=UTC tsx --test)
// The query compiler + search plan are pure — these tests pin the reliability contract:
// timezone-correct dates, conditional default window, variant fan-out, broadening ladder.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddressQuery, looseAddressQuery, dateClause, buildSearchPlan, DEFAULT_SEARCH_WINDOW_DAYS } from './gmail.js';
import { zonedTimeToUtcMs } from '../pipeline/zonedTime.js';

// ── dateClause: epoch seconds in the USER's zone, never PST-midnight strings ──

test('dateClause compiles to epoch seconds at midnight in the given timezone', () => {
  // 2026-05-01 00:00 America/Chicago is CDT (UTC-5) → 05:00Z.
  const expected = Math.floor(zonedTimeToUtcMs({ year: 2026, month: 5, day: 1 }, 'America/Chicago') / 1000);
  assert.equal(dateClause('after', '2026-05-01', 'America/Chicago'), `after:${expected}`);
  assert.equal(Date.UTC(2026, 4, 1, 5) / 1000, expected); // sanity: CDT offset really is -5
});

test('dateClause accepts slashes and rejects malformed dates', () => {
  assert.ok(dateClause('before', '2026/02/10', 'America/Chicago')?.startsWith('before:'));
  assert.equal(dateClause('after', '2026-02-30', 'America/Chicago'), null); // impossible date
  assert.equal(dateClause('after', 'last week', 'America/Chicago'), null);
});

// ── default window: applied only when there is NO date signal ─────────────────

test('default window applies when the spec carries no date signal', () => {
  const plan = buildSearchPlan({ terms: ['appraisal'] });
  assert.equal(plan.defaultWindowApplied, `newer_than:${DEFAULT_SEARCH_WINDOW_DAYS}d`);
  assert.ok(plan.variants[0].q.includes(`newer_than:${DEFAULT_SEARCH_WINDOW_DAYS}d`));
});

test('no default window with explicit after/before, newer_than_days, 0, or raw date ops', () => {
  assert.equal(buildSearchPlan({ after: '2026-01-01', timezone: 'America/Chicago' }).defaultWindowApplied, null);
  assert.equal(buildSearchPlan({ newerThanDays: 30 }).defaultWindowApplied, null);
  const unbounded = buildSearchPlan({ newerThanDays: 0, terms: ['contract'] });
  assert.equal(unbounded.defaultWindowApplied, null);
  assert.ok(!unbounded.variants[0].q.includes('newer_than'));
  assert.equal(buildSearchPlan({ query: 'appraisal newer_than:30d' }).defaultWindowApplied, null);
});

test('explicit after/before compile into every variant', () => {
  const plan = buildSearchPlan({ after: '2026-05-01', before: '2026-06-01', terms: ['survey'], timezone: 'America/Chicago' });
  assert.match(plan.variants[0].q, /after:\d{10}/);
  assert.match(plan.variants[0].q, /before:\d{10}/);
  assert.ok(!plan.variants[0].q.includes('newer_than'));
});

// ── typed clause compilation ──────────────────────────────────────────────────

test('typed params compile with quoting where needed', () => {
  const plan = buildSearchPlan({
    from: 'Jane Roe', subject: 'appraisal', phrase: 'repair credit',
    terms: ['inspection', 'wind mitigation'], filename: 'pdf', hasAttachment: true, newerThanDays: 0,
  });
  const q = plan.variants[0].q;
  assert.ok(q.includes('from:"Jane Roe"'));
  assert.ok(q.includes('subject:appraisal'));
  assert.ok(q.includes('"repair credit"'));
  assert.ok(q.includes('inspection'));
  assert.ok(q.includes('"wind mitigation"'));
  assert.ok(q.includes('filename:pdf'));
  assert.ok(q.includes('has:attachment'));
});

test('client compiles as from/to for emails, quoted phrase for names', () => {
  assert.ok(buildSearchPlan({ client: 'bob@lender.com', newerThanDays: 0 }).variants[0].q.includes('(from:bob@lender.com OR to:bob@lender.com)'));
  assert.ok(buildSearchPlan({ client: 'Bob Vance', newerThanDays: 0 }).variants[0].q.includes('"Bob Vance"'));
});

// ── variants: model-supplied formulations fan out; capped and deduped ─────────

test('queries[] become parallel variants, capped at 5, deduped, base kept when query set', () => {
  const plan = buildSearchPlan({
    address: '1042 Maple St',
    query: 'inspection',
    queries: ['appraisal', 'appraisal', '"title commitment"', 'survey', 'hoa', 'escrow', 'lender'],
    newerThanDays: 0,
  });
  const labels = plan.variants.map(v => v.label);
  assert.equal(labels[0], 'base');                       // the `query` clause rides first
  assert.ok(plan.variants.length <= 6);
  const qs = new Set(plan.variants.map(v => v.q));
  assert.equal(qs.size, plan.variants.length);           // deduped
  assert.ok(plan.variants.every(v => v.q.includes('"1042 Maple St"'))); // structural clauses on every variant
});

// ── the broadening ladder ─────────────────────────────────────────────────────

test('ladder relaxes client, dates, address, then goes wide-open with spam/trash', () => {
  const plan = buildSearchPlan({ address: '1042 Maple St', client: 'Bob Vance', terms: ['inspection'] });
  const labels = plan.ladder.map(l => l.label);
  assert.deepEqual(labels, ['without-client', 'all-time', 'loose-address', 'wide-open']);
  const noClient = plan.ladder[0];
  assert.ok(!noClient.q.includes('Bob Vance'));
  const allTime = plan.ladder[1];
  assert.ok(!allTime.q.includes('newer_than'));
  const loose = plan.ladder[2];
  assert.ok(loose.q.includes('"1042 Maple"'));
  const wide = plan.ladder[3];
  assert.equal(wide.includeSpamTrash, true);
  assert.ok(!wide.q.includes('newer_than') && !wide.q.includes('Bob Vance'));
});

test('queries[]-driven ladder keeps the first formulation through intermediate steps', () => {
  const plan = buildSearchPlan({
    address: '1042 Maple St', client: 'Bob Vance',
    queries: ['(appraisal OR appraiser)', 'subject:appraisal'],
    after: '2026-03-01', timezone: 'America/Chicago',
  });
  const byLabel = Object.fromEntries(plan.ladder.map(l => [l.label, l]));
  assert.ok(byLabel['without-client'].q.includes('appraisal'));   // keyword anchor survives
  assert.ok(byLabel['all-time'].q.includes('appraisal'));
  assert.ok(byLabel['loose-address'].q.includes('appraisal'));
  assert.ok(!byLabel['wide-open'].q.includes('appraisal'));        // last resort drops keywords
  assert.ok(byLabel['wide-open'].includeSpamTrash);
});

test('ladder skips steps that would not change the query', () => {
  const plan = buildSearchPlan({ terms: ['inspection'], newerThanDays: 0 });
  const labels = plan.ladder.map(l => l.label);
  assert.ok(!labels.includes('without-client'));  // no client to drop
  assert.ok(!labels.includes('all-time'));        // already unbounded
  assert.ok(!labels.includes('loose-address'));   // no address
  assert.deepEqual(labels, ['wide-open']);        // only the spam/trash widening remains
});

// ── address helpers ───────────────────────────────────────────────────────────

test('buildAddressQuery keeps street-type variants; looseAddressQuery anchors number+first word', () => {
  const full = buildAddressQuery('1042 Maple St');
  // Variants are emitted lowercase (Gmail matching is case-insensitive) — compare accordingly.
  assert.ok(full.includes('"1042 Maple St"') && full.toLowerCase().includes('"1042 maple street"'));
  assert.equal(looseAddressQuery('1042 Maplewood Grove Ln'), '"1042 Maplewood"');
  assert.equal(looseAddressQuery('The Maple House'), null);
});
