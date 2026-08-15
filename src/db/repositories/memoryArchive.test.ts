// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The cold archive (tier 0): insert/search round-trip, the handle-vs-chat scope that keeps one
// user's past out of another's, ranking, the content cap, the per-handle row cap, purge, and
// BOTH search backends — FTS5 as the build provides it, plus a forced LIKE pass, since the
// fallback must answer the same question the same way.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveEntries, searchArchive, purgeArchiveFor, sweepArchiveCaps, listArchiveFor,
  archiveSearchBackend, __setArchiveBackendForTests,
  ARCHIVE_CONTENT_MAX_CHARS, ARCHIVE_MAX_ROWS_PER_HANDLE,
} from './memoryArchive.js';
import { stmt } from '../sqlite.js';

let seq = 0;
function freshHandle(): string {
  return `+1555200${(seq++).toString().padStart(4, '0')}`;
}

/** Every assertion below is run once per backend — the LIKE path is the degraded-build contract. */
const BACKENDS: Array<'fts5' | 'like'> = ['fts5', 'like'];

function withBackend(backend: 'fts5' | 'like', fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    __setArchiveBackendForTests(backend);
    try {
      await fn();
    } finally {
      __setArchiveBackendForTests(null);
    }
  };
}

test('this build has fts5 (the LIKE path is a fallback, not the norm)', () => {
  assert.equal(archiveSearchBackend(), 'fts5');
});

for (const backend of BACKENDS) {
  test(`[${backend}] archive round-trip: an entry is searchable by a word in its content`, withBackend(backend, async () => {
    const h = freshHandle();
    await archiveEntries([{
      source: 'medium_superseded', agentHandle: h, kind: 'fact', request: 'brokerage',
      content: 'works at Keller Williams in the Cedar Park office', createdAt: Date.now() - 86_400_000,
    }]);
    const hits = await searchArchive({ query: 'keller', handle: h });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].entry.source, 'medium_superseded');
    assert.equal(hits[0].entry.request, 'brokerage');
    assert.match(hits[0].snippet, /Keller/);
  }));

  test(`[${backend}] scoping: another handle's archive is invisible`, withBackend(backend, async () => {
    const mine = freshHandle();
    const theirs = freshHandle();
    await archiveEntries([
      { source: 'message_pruned', agentHandle: mine, chatId: `chat-mine-${backend}`, content: 'my lake cabin is called the shack' },
      { source: 'message_pruned', agentHandle: theirs, chatId: `chat-theirs-${backend}`, content: 'their lake cabin is called the barn' },
    ]);
    const hits = await searchArchive({ query: 'lake cabin', handle: mine, chatId: `chat-mine-${backend}` });
    assert.equal(hits.length, 1);
    assert.match(hits[0].entry.content, /the shack/);

    // An unscoped search reaches nothing at all rather than everything.
    assert.deepEqual(await searchArchive({ query: 'lake cabin' }), []);
  }));

  test(`[${backend}] scoping: a chat's rows are reachable without the handle`, withBackend(backend, async () => {
    const h = freshHandle();
    await archiveEntries([
      { source: 'message_pruned', chatId: `chat-shared-${backend}`, content: 'the juniper closing moved to friday' },
    ]);
    assert.equal((await searchArchive({ query: 'juniper', chatId: `chat-shared-${backend}` })).length, 1);
    assert.equal((await searchArchive({ query: 'juniper', handle: h })).length, 0);
  }));

  test(`[${backend}] ranking: a two-term match outranks a one-term match`, withBackend(backend, async () => {
    const h = freshHandle();
    await archiveEntries([
      { source: 'short_expired', agentHandle: h, content: 'notes about the marathon' },
      { source: 'short_expired', agentHandle: h, content: 'the boston marathon training plan, week nine' },
    ]);
    const hits = await searchArchive({ query: 'boston marathon', handle: h });
    assert.equal(hits.length, 2);
    assert.match(hits[0].entry.content, /boston marathon/);
    assert.ok(hits[0].score >= hits[1].score);
  }));

  test(`[${backend}] a query of pure punctuation finds nothing (and never throws)`, withBackend(backend, async () => {
    const h = freshHandle();
    await archiveEntries([{ source: 'short_expired', agentHandle: h, content: 'anything at all' }]);
    assert.deepEqual(await searchArchive({ query: '   *** ', handle: h }), []);
  }));

  test(`[${backend}] FTS operators in a user query are data, not syntax`, withBackend(backend, async () => {
    const h = freshHandle();
    await archiveEntries([{ source: 'short_expired', agentHandle: h, content: 'the hendersons want a fence quote' }]);
    // Would be a syntax error (or a wildly different query) if the tokens reached MATCH raw.
    const hits = await searchArchive({ query: 'hendersons NEAR("x" OR *', handle: h });
    assert.equal(hits.length, 1);
  }));
}

test('content is sliced to ARCHIVE_CONTENT_MAX_CHARS', async () => {
  const h = freshHandle();
  await archiveEntries([{ source: 'message_pruned', agentHandle: h, content: `sprawling ${'x'.repeat(ARCHIVE_CONTENT_MAX_CHARS + 500)}` }]);
  const [entry] = await listArchiveFor(h);
  assert.equal(entry.content.length, ARCHIVE_CONTENT_MAX_CHARS);
});

test('an unknown source is refused, not stored', async () => {
  const h = freshHandle();
  await archiveEntries([{ source: 'not_a_real_source' as never, agentHandle: h, content: 'should not land' }]);
  assert.equal((await listArchiveFor(h)).length, 0);
});

test('archiveEntries never throws, even on a broken row', async () => {
  // Empty content is skipped rather than inserted (NOT NULL would reject it anyway).
  await archiveEntries([{ source: 'short_expired', agentHandle: freshHandle(), content: '' }]);
});

// Both cap enforcement points in one test: filling a handle to the cap is the expensive part
// (ARCHIVE_MAX_ROWS_PER_HANDLE raw inserts), so the per-insert eviction and the sweep share it.
test('the per-handle cap evicts oldest-first, on insert and in the sweep', async () => {
  const h = freshHandle();
  const other = freshHandle();
  const insert = stmt(
    `INSERT INTO memory_archive (agent_handle, source, content, meta_json, created_at, archived_at)
     VALUES (?, 'message_pruned', ?, '{}', ?, ?)`
  );
  // archived_at = i + 1 makes "oldest" unambiguous.
  for (let i = 0; i < ARCHIVE_MAX_ROWS_PER_HANDLE; i++) insert.run(h, `row ${i}`, i + 1, i + 1);
  insert.run(other, 'untouched', 1, 1);

  const count = (handle: string) =>
    (stmt('SELECT count(*) AS n FROM memory_archive WHERE agent_handle = ?').get(handle) as { n: number }).n;
  const oldest = (handle: string) =>
    (stmt('SELECT content FROM memory_archive WHERE agent_handle = ? ORDER BY archived_at ASC, id ASC LIMIT 1').get(handle) as { content: string }).content;

  // At the cap: one more insert stays at the cap and drops the oldest row.
  await archiveEntries([{ source: 'short_expired', agentHandle: h, content: 'the newest thing they said' }]);
  assert.equal(count(h), ARCHIVE_MAX_ROWS_PER_HANDLE);
  assert.equal(oldest(h), 'row 1', 'row 0 was evicted');
  assert.equal((await searchArchive({ query: 'newest', handle: h }))[0]?.entry.content, 'the newest thing they said');

  // Rows planted around the repository (or an older build) are caught by the daily sweep.
  for (let i = 0; i < 3; i++) insert.run(h, `extra ${i}`, 1_000_000 + i, 1_000_000 + i);
  assert.equal(await sweepArchiveCaps(), 3);
  assert.equal(count(h), ARCHIVE_MAX_ROWS_PER_HANDLE);
  assert.equal(oldest(h), 'row 4', 'the sweep also took the oldest three');
  assert.equal(count(other), 1, 'a handle under the cap is untouched');

  // Leave the table small for the tests after this one.
  await purgeArchiveFor({ handle: h });
  await purgeArchiveFor({ handle: other });
});

test('purgeArchiveFor drops by handle and by chat, leaving everything else', async () => {
  const h = freshHandle();
  const keep = freshHandle();
  await archiveEntries([
    { source: 'short_expired', agentHandle: h, chatId: 'chat-purge', content: 'forget me' },
    { source: 'short_expired', chatId: 'chat-purge', content: 'chat-scoped, no handle' },
    { source: 'short_expired', agentHandle: keep, chatId: 'chat-other', content: 'keep me' },
  ]);
  const removed = await purgeArchiveFor({ handle: h, chatId: 'chat-purge' });
  assert.equal(removed, 2);
  assert.equal((await listArchiveFor(h)).length, 0);
  assert.equal((await searchArchive({ query: 'forget', chatId: 'chat-purge' })).length, 0);
  assert.equal((await searchArchive({ query: 'keep', handle: keep })).length, 1);
});
