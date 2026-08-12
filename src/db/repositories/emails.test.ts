// Run with: npm test   (TZ=UTC tsx --test)
// Exercises the local mail search index on the in-memory backend (no Supabase creds in tests):
// upsert idempotence, substring matching across fields, filters, ordering, stats, teardown.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertEmails, searchEmailIndex, emailIndexStats, clearEmailIndex } from './emails.js';
import type { DealEmail } from '../../services/gmail.js';

const HANDLE = '+15550001111';

function mail(over: Partial<DealEmail>): DealEmail {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2)}`,
    threadId: over.threadId ?? 't-1',
    from: over.from ?? 'Jane Roe <jane@lender.com>',
    to: over.to ?? ['agent@example.com'],
    date: over.date ?? 'Mon, 06 Jul 2026 09:00:00 -0500',
    internalDate: over.internalDate ?? Date.parse('2026-07-06T14:00:00Z'),
    subject: over.subject ?? 'Loan update',
    snippet: over.snippet ?? '',
    bodyText: over.bodyText ?? '',
    attachments: over.attachments ?? [],
    labelIds: over.labelIds ?? ['INBOX'],
  };
}

test('upsert + substring search across subject/from/body; newest first', async () => {
  await clearEmailIndex(HANDLE);
  await upsertEmails(HANDLE, [
    mail({ id: 'a', subject: 'Inspection scheduled — 1042 Maplewood Grove', internalDate: 1_000 }),
    mail({ id: 'b', bodyText: 'The appraisal came back at value for the Maplewood file.', internalDate: 3_000 }),
    mail({ id: 'c', subject: 'Totally unrelated', bodyText: 'nothing here', internalDate: 2_000 }),
  ]);

  // Substring: "maplew" is a partial word Gmail's own search could never match.
  const hits = await searchEmailIndex(HANDLE, { text: 'maplew' });
  assert.deepEqual(hits.map(h => h.id), ['b', 'a']); // newest first
});

test('upsert is idempotent per (handle, id)', async () => {
  await clearEmailIndex(HANDLE);
  await upsertEmails(HANDLE, [mail({ id: 'dup', subject: 'v1' })]);
  await upsertEmails(HANDLE, [mail({ id: 'dup', subject: 'v2 — corrected subject' })]);
  const all = await searchEmailIndex(HANDLE, {});
  assert.equal(all.length, 1);
  assert.equal(all[0].subject, 'v2 — corrected subject');
});

test('filters AND together: from, subject, dates, has_attachment, limit', async () => {
  await clearEmailIndex(HANDLE);
  await upsertEmails(HANDLE, [
    mail({ id: 'p1', from: 'Title Co <docs@titleco.com>', subject: 'Commitment attached', internalDate: 5_000, attachments: [{ attachmentId: 'x', messageId: 'p1', filename: 'commitment.pdf', mimeType: 'application/pdf', sizeBytes: 10 }] }),
    mail({ id: 'p2', from: 'Title Co <docs@titleco.com>', subject: 'Commitment question', internalDate: 6_000 }),
    mail({ id: 'p3', from: 'jane@lender.com', subject: 'Commitment attached', internalDate: 7_000 }),
  ]);

  assert.deepEqual((await searchEmailIndex(HANDLE, { from: 'titleco', subject: 'commitment' })).map(h => h.id), ['p2', 'p1']);
  assert.deepEqual((await searchEmailIndex(HANDLE, { from: 'titleco', hasAttachment: true })).map(h => h.id), ['p1']);
  assert.deepEqual((await searchEmailIndex(HANDLE, { afterMs: 5_500, beforeMs: 6_500 })).map(h => h.id), ['p2']);
  assert.equal((await searchEmailIndex(HANDLE, { limit: 2 })).length, 2);
});

test('stats report coverage; clear removes everything for the handle only', async () => {
  await clearEmailIndex(HANDLE);
  await clearEmailIndex('+15559998888');
  await upsertEmails(HANDLE, [mail({ id: 's1', internalDate: 1_000 }), mail({ id: 's2', internalDate: 9_000 })]);
  await upsertEmails('+15559998888', [mail({ id: 'other' })]);

  const stats = await emailIndexStats(HANDLE);
  assert.equal(stats.count, 2);
  assert.equal(stats.oldestMs, 1_000);
  assert.equal(stats.newestMs, 9_000);

  await clearEmailIndex(HANDLE);
  assert.equal((await emailIndexStats(HANDLE)).count, 0);
  assert.equal((await emailIndexStats('+15559998888')).count, 1); // untouched
  await clearEmailIndex('+15559998888');
});
