// Run with: npm test   (TZ=UTC tsx --test)
// The pure pieces of the daily digest pass. Host tz pinned to UTC — the fallback's greeting must
// read off the USER's zone, never the host clock or the hour the automation was scheduled for.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeInZone } from './zonedTime.js';
import { buildDigestBrief, fallbackDigest } from './emailJudge.js';
import type { JudgeVerdict } from '../agents/judge/client.js';
import type { DealEmail } from '../services/gmail.js';

// Wed Aug 5 2026 in America/Chicago (CDT). 6:00 AM here is 8:00 PM the same instant in Asia/Tokyo.
const MORNING_CT = dateTimeInZone('2026-08-05', { hour: 6 });
const AFTERNOON_CT = dateTimeInZone('2026-08-05', { hour: 14 });
const LATE_NIGHT_CT = dateTimeInZone('2026-08-05', { hour: 23, minute: 30 });

function email(over: Partial<DealEmail> = {}): DealEmail {
  return {
    id: 'm1', threadId: 't1', from: '"Dana Whitfield" <dana@northwind.example>',
    to: ['user@example.com'], date: 'Wed, 5 Aug 2026 06:02:00 -0500', internalDate: MORNING_CT,
    subject: 'Revised quote for the shack', snippet: 'they came back at 4150', bodyText: 'they came back at 4150',
    attachments: [], labelIds: ['UNREAD'], ...over,
  };
}

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    important: true, severity: 'medium', category: 'action_required', suspectedFraud: false,
    deadlineDate: null, deadlineLabel: null, summary: 'dana sent a revised quote',
    suggestReminder: false, ...over,
  };
}

const item = (v: Partial<JudgeVerdict> = {}, e: Partial<DealEmail> = {}) => ({ email: email(e), verdict: verdict(v) });

// ── fallbackDigest branches ──────────────────────────────────────────────────

test('one important email: the deadline rides the greeting and the summary is its own bubble', () => {
  const out = fallbackDigest([item({ deadlineDate: '2026-08-07' })], 'America/Chicago', MORNING_CT);
  assert.deepEqual(out.split('\n---\n'), [
    "morning, you got something worth a look and it's due 2026-08-07",
    'dana sent a revised quote',
    'let me know if you want the details',
  ]);
});

test('a critical email leads the batch and the rest stay unnamed', () => {
  const out = fallbackDigest([
    item({ summary: 'the inspection report is in' }),
    item({ severity: 'critical', summary: 'payment instructions changed, verify by phone' }, { id: 'm2' }),
  ], 'America/Chicago', MORNING_CT);
  assert.ok(out.startsWith("morning, you've got 2 things"), out);
  assert.ok(out.includes('needs attention right away'), out);
  assert.ok(out.includes('payment instructions changed, verify by phone'), out);
  assert.ok(!out.includes('the inspection report is in'), out);
});

test('suspected fraud takes the critical branch even at low severity', () => {
  const out = fallbackDigest([
    item(),
    item({ severity: 'low', suspectedFraud: true, summary: 'someone is spoofing the bank' }, { id: 'm2' }),
  ], 'America/Chicago', MORNING_CT);
  assert.ok(out.includes('someone is spoofing the bank'), out);
});

test('a plain batch counts them, names none, and never claims they came overnight', () => {
  const out = fallbackDigest([item(), item({}, { id: 'm2' }), item({}, { id: 'm3' })], 'America/Chicago', AFTERNOON_CT);
  assert.deepEqual(out.split('\n---\n'), [
    'afternoon, 3 things came through that are worth a look',
    'i can break them down for you whenever you\'re ready',
  ]);
});

test('every branch stays inside 3 bubbles and carries no bullets or markdown', () => {
  const batches = [
    [item({ deadlineDate: '2026-08-07' })],
    [item({ severity: 'critical' }), item({}, { id: 'm2' })],
    [item(), item({}, { id: 'm2' })],
  ];
  for (const batch of batches) {
    const bubbles = fallbackDigest(batch, 'America/Chicago', MORNING_CT).split('\n---\n');
    assert.ok(bubbles.length <= 3, `${bubbles.length} bubbles: ${JSON.stringify(bubbles)}`);
    for (const bubble of bubbles) {
      assert.ok(bubble.trim().length > 0, `empty bubble in ${JSON.stringify(bubbles)}`);
      assert.ok(!/[*_#`•·▪|]/.test(bubble), `bubble carries a symbol: ${bubble}`);
    }
  }
});

// ── the greeting ─────────────────────────────────────────────────────────────

test('the greeting reads the USER clock, not the host and not the scheduled hour', () => {
  const one = [item()];
  // 6am Chicago is "early morning" — the greeting collapses it to plain "morning".
  assert.ok(fallbackDigest(one, 'America/Chicago', MORNING_CT).startsWith('morning,'));
  // Same instant, other side of the world: 8pm in Tokyo.
  assert.ok(fallbackDigest(one, 'Asia/Tokyo', MORNING_CT).startsWith('evening,'));
  assert.ok(fallbackDigest(one, 'America/Chicago', AFTERNOON_CT).startsWith('afternoon,'));
  // Nobody says "morning" at 11:30pm — a re-timed or retried pass has to sound like a person.
  assert.ok(fallbackDigest(one, 'America/Chicago', LATE_NIGHT_CT).startsWith('hey,'));
});

test('a saved timezone Intl rejects falls back to the default clock instead of throwing', () => {
  // agent_tz holds whatever surfaced in conversation, unvalidated — and this is the path that
  // guarantees the digest still goes out (a throw would also stall the dedupe ring for good).
  assert.ok(fallbackDigest([item()], 'Eastern', MORNING_CT).startsWith('morning,'));
  assert.ok(fallbackDigest([item()], 'GMT-5', AFTERNOON_CT).startsWith('afternoon,'));
});

// ── buildDigestBrief ─────────────────────────────────────────────────────────

test('the brief hands the model the full From field, the count, and each verdict', () => {
  const brief = buildDigestBrief([
    item({ deadlineDate: '2026-08-07', deadlineLabel: 'response window' }),
    item({ severity: 'high', category: 'financial' }, { id: 'm2', from: 'Billing <ops@utility.example>' }),
  ], 'America/Chicago');
  assert.ok(brief.includes('There are 2 important unread email(s)'), brief);
  assert.ok(brief.includes("The user's timezone is America/Chicago"), brief);
  assert.ok(brief.includes('1. from: "Dana Whitfield" <dana@northwind.example>'), brief);
  assert.ok(brief.includes('2. from: Billing <ops@utility.example>'), brief);
  assert.ok(brief.includes('deadline: response window 2026-08-07'), brief);
  assert.ok(brief.includes('severity high, category financial, no deadline'), brief);
  // The addresses are there for domain reasoning only — the instruction that keeps them off the
  // user's screen has to ride with them.
  assert.ok(brief.includes('NEVER include email addresses'), brief);
});
