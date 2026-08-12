// Run with: npm test   (TZ=UTC tsx --test)
// The search-result renderers ARE the tool contract the model sees: query echo, counts,
// ladder trail, pagination pressure, and zero-hit steering. Pin the load-bearing pieces.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGmailSearch, renderLocalSearch } from './tools.js';
import type { EmailSearchResult, DealEmail } from '../../services/gmail.js';
import type { IndexedEmail } from '../../db/repositories/emails.js';

function hit(id: string): DealEmail {
  return {
    id, threadId: `t-${id}`, from: 'jane@lender.com', to: ['me@x.com'],
    date: 'Mon, 06 Jul 2026 09:00:00 -0500', internalDate: 1, subject: 'Appraisal back',
    snippet: '', bodyText: 'The appraisal came in at value.', labelIds: [],
    attachments: [{ attachmentId: 'att-1', messageId: id, filename: 'appraisal.pdf', mimeType: 'application/pdf', sizeBytes: 9 }],
  };
}

function result(over: Partial<EmailSearchResult>): EmailSearchResult {
  return {
    emails: [], perVariant: [], ladderTrail: [], usedLadder: null,
    totalListed: 0, unhydrated: 0, nextPageToken: null, defaultWindowApplied: null,
    ...over,
  };
}

test('results echo every effective query with counts, and surface attachments + page pressure', () => {
  const out = renderGmailSearch(result({
    emails: [hit('m1')],
    perVariant: [
      { label: 'base', q: '"1042 Maple St" appraisal newer_than:365d', count: 1 },
      { label: 'variant-1', q: '"1042 Maple St" "appraised value"', count: 0 },
    ],
    totalListed: 1,
    defaultWindowApplied: 'newer_than:365d',
    nextPageToken: 'TOK123',
  }));
  assert.match(out, /searched \[base\]: .*appraisal.* → 1 hit/);
  assert.match(out, /searched \[variant-1\]: .* → 0 hit/);
  assert.match(out, /default window newer_than:365d/);
  assert.match(out, /id=m1/);
  assert.match(out, /appraisal\.pdf \(id=att-1/);
  assert.match(out, /MORE RESULTS EXIST — pass page_token: "TOK123"/);
});

test('a ladder rescue labels the results as coming from the broader net', () => {
  const out = renderGmailSearch(result({
    emails: [hit('m9')],
    perVariant: [{ label: 'base', q: '"1042 Maple St" survey', count: 0 }],
    usedLadder: { label: 'all-time', q: '"1042 Maple St" survey', count: 1 },
    ladderTrail: [{ label: 'all-time', q: '"1042 Maple St" survey', count: 1 }],
    totalListed: 1,
  }));
  assert.match(out, /auto-broadened \[all-time\]/);
  assert.match(out, /verify they match the ask/);
});

test('zero hits steer instead of terminating: trail, next moves, absence warning', () => {
  const out = renderGmailSearch(result({
    perVariant: [{ label: 'base', q: '"1042 Maple St" payoff', count: 0 }],
    ladderTrail: [
      { label: 'all-time', q: '"1042 Maple St" payoff', count: 0 },
      { label: 'wide-open', q: '"1042 Maple" payoff', count: 0 },
    ],
  }));
  assert.match(out, /no matching emails found/);
  assert.match(out, /auto-broadening also found nothing \(tried: all-time, wide-open\)/);
  assert.match(out, /search_inbox_local/);
  assert.match(out, /NOT "does not exist"/);
});

test('local search always leads with coverage; empty index redirects to live search', () => {
  const idx: IndexedEmail = {
    handle: 'h', id: 'L1', threadId: 't', from: 'bob@title.com', to: 'me@x.com',
    subject: 'Commitment', snippet: 's', bodyText: 'title commitment attached for Maplewood',
    haystack: '', labels: [], attachments: [], hasAttachments: false,
    internalDate: Date.parse('2026-07-01T00:00:00Z'),
  };
  const out = renderLocalSearch([idx], { count: 812, oldestMs: Date.parse('2024-08-01T00:00:00Z'), newestMs: Date.parse('2026-07-10T00:00:00Z') });
  assert.match(out, /local index coverage: 812 message\(s\), 2024-08-01 → 2026-07-10/);
  assert.match(out, /id=L1/);

  const empty = renderLocalSearch([], { count: 0, oldestMs: null, newestMs: null });
  assert.match(empty, /not been backfilled yet/);
  assert.match(empty, /search_email/);
});
