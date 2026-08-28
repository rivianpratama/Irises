// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The archive's companion vectors: the codec, the bounded newest-first backfill and its forget
// fence, and — the ones that matter most — the four ways a vector must disappear when the archive
// row behind it does. A vector that outlives its row is a forgotten memory still reachable.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// Pin the store's notion of "current" so the fake embedder's 64-dim vectors ARE the current ones.
process.env.EMBEDDINGS_MODEL = 'test/fake-embed';
process.env.EMBEDDINGS_DIMENSIONS = '64';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setArchiveEmbedder, archiveEmbedder, encodeVector, decodeVector, l2Normalize, dot,
  upsertArchiveVector, vectorCandidates, backfillArchiveEmbeddings, deleteVectorsForScope,
  countMissingVectors, embeddingsModel, embeddingsDims, type Embedder,
} from './memoryArchiveVectors.js';
import {
  archiveEntries, purgeArchiveFor, sweepArchiveCaps, ARCHIVE_MAX_ROWS_PER_HANDLE,
} from './memoryArchive.js';
import { bumpForgetEpoch } from './memory.js';
import { getDb, stmt, resetStorageForTests } from '../sqlite.js';

const DIMS = 64;
const MODEL = 'test/fake-embed';

let seq = 0;
function freshHandle(): string {
  return `+1555300${(seq++).toString().padStart(4, '0')}`;
}

/** Deterministic bag-of-words at 64 dims: hash each token into a bucket, then L2-normalize.
 *  Shared words ⇒ high cosine, disjoint words ⇒ ~0 — enough for ranking assertions without a
 *  provider. Fixtures override it for the cases that need an exact similarity. */
function bagOfWords(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  return l2Normalize(v);
}

function fakeEmbedder(over: (texts: string[]) => void = () => {}): Embedder {
  return async (texts) => {
    over(texts);
    return texts.map(bagOfWords);
  };
}

function seedRow(handle: string | null, content: string, archivedAt: number, chatId: string | null = null): number {
  const res = stmt(
    `INSERT INTO memory_archive (agent_handle, chat_id, source, content, meta_json, created_at, archived_at)
     VALUES (?, ?, 'message_pruned', ?, '{}', ?, ?)`
  ).run(handle, chatId, content, archivedAt, archivedAt);
  return Number(res.lastInsertRowid);
}

function vectorIdsFor(handle: string): number[] {
  return (stmt(
    `SELECT e.archive_id AS id FROM memory_archive_embeddings e
     JOIN memory_archive a ON a.id = e.archive_id
     WHERE a.agent_handle = ? ORDER BY e.archive_id`
  ).all(handle) as unknown as Array<{ id: number }>).map(r => Number(r.id));
}

function vectorCount(): number {
  return Number((stmt('SELECT count(*) AS n FROM memory_archive_embeddings').get() as { n: number }).n);
}

function withEmbedder(fn: Embedder, body: () => Promise<void>): () => Promise<void> {
  return async () => {
    setArchiveEmbedder(fn);
    try {
      await body();
    } finally {
      setArchiveEmbedder(null);
    }
  };
}

test('encode/decode round-trips a vector exactly', () => {
  const v = l2Normalize(bagOfWords('the lake cabin is called the shack'));
  const back = decodeVector(encodeVector(v), DIMS);
  assert.ok(back);
  assert.equal(back!.length, DIMS);
  for (let i = 0; i < DIMS; i++) assert.equal(back![i], v[i]);
  // Round-tripped through SQLite too — the BLOB path is the one that actually matters.
  const id = seedRow(freshHandle(), 'round trip', Date.now());
  assert.equal(upsertArchiveVector(id, v, MODEL, DIMS), true);
  const row = stmt('SELECT vector, dims FROM memory_archive_embeddings WHERE archive_id = ?').get(id) as { vector: Uint8Array; dims: number };
  const stored = decodeVector(row.vector, Number(row.dims));
  assert.ok(stored);
  assert.ok(Math.abs(dot(stored!, v) - 1) < 1e-6, 'a stored vector is unit-length and identical');
});

test('decodeVector returns null on a truncated or misaligned blob, never throws', () => {
  const v = bagOfWords('anything at all');
  const blob = encodeVector(v);
  assert.equal(decodeVector(blob.subarray(0, blob.byteLength - 4), DIMS), null, 'truncated');
  assert.equal(decodeVector(blob, DIMS + 1), null, 'width disagrees with dims');
  assert.equal(decodeVector(new Uint8Array(0), DIMS), null, 'empty');
  // Misaligned view (byteOffset 1): decoded via the copy path rather than throwing.
  const padded = Buffer.alloc(blob.byteLength + 1);
  blob.copy(padded, 1);
  const misaligned = new Uint8Array(padded.buffer, padded.byteOffset + 1, blob.byteLength);
  const back = decodeVector(misaligned, DIMS);
  assert.ok(back, 'a misaligned blob is copied, not rejected');
  assert.ok(Math.abs(dot(back!, v) - 1) < 1e-6);
});

test('backfill embeds only rows with no vector, newest-first', withEmbedder(fakeEmbedder(), async () => {
  const h = freshHandle();
  const base = Date.now();
  const oldest = seedRow(h, 'oldest thing', base + 1);
  const middle = seedRow(h, 'middle thing', base + 2);
  const newest = seedRow(h, 'newest thing', base + 3);

  const first = await backfillArchiveEmbeddings({ batchSize: 1, maxBatches: 1 });
  assert.equal(first.embedded, 1);
  assert.deepEqual(vectorIdsFor(h), [newest], 'newest first');

  const second = await backfillArchiveEmbeddings({ batchSize: 1, maxBatches: 1 });
  assert.equal(second.embedded, 1);
  assert.deepEqual(vectorIdsFor(h), [middle, newest].sort((a, b) => a - b), 'the already-embedded row is skipped');

  const third = await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 10 });
  assert.equal(third.embedded, 1, 'only the last row was left to do');
  assert.equal(third.remaining, 0);
  assert.equal(vectorIdsFor(h).length, 3);
  assert.ok([oldest, middle, newest].every(id => vectorIdsFor(h).includes(id)));
  await purgeArchiveFor({ handle: h });
}));

test('backfill is bounded by batchSize × maxBatches', async () => {
  const h = freshHandle();
  const base = Date.now();
  for (let i = 0; i < 10; i++) seedRow(h, `row ${i}`, base + i);
  let embedCalls = 0;
  let textsSeen = 0;
  await withEmbedder(fakeEmbedder(texts => { embedCalls++; textsSeen += texts.length; }), async () => {
    const res = await backfillArchiveEmbeddings({ batchSize: 2, maxBatches: 3 });
    assert.equal(res.batches, 3);
    assert.equal(res.embedded, 6, 'six rows, not ten');
    assert.equal(textsSeen, 6);
    assert.equal(embedCalls, 3, 'one call per batch (one handle in each)');
    assert.equal(res.remaining, 4, 'the rest waits for the next run');
    assert.equal(vectorIdsFor(h).length, 6);
  })();
  await purgeArchiveFor({ handle: h });
});

test('backfill re-embeds rows whose stored model no longer matches config', withEmbedder(fakeEmbedder(), async () => {
  const h = freshHandle();
  const id = seedRow(h, 'a memory embedded by an older model', Date.now());
  // A vector written under a model this build no longer uses.
  stmt(
    `INSERT OR REPLACE INTO memory_archive_embeddings (archive_id, vector, dims, model, created_at)
     VALUES (?, ?, ?, 'test/retired-embed', ?)`
  ).run(id, encodeVector(bagOfWords('stale')), DIMS, Date.now());
  assert.equal(countMissingVectors(), 1, 'a stale-model row counts as missing');

  const res = await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 1 });
  assert.equal(res.embedded, 1);
  const row = stmt('SELECT model FROM memory_archive_embeddings WHERE archive_id = ?').get(id) as { model: string };
  assert.equal(row.model, embeddingsModel());
  assert.equal(countMissingVectors(), 0);
  await purgeArchiveFor({ handle: h });
}));

test('a vector write for an archive row deleted mid-flight is a no-op, not an FK error', () => {
  const h = freshHandle();
  const id = seedRow(h, 'this row is about to be forgotten', Date.now());
  stmt('DELETE FROM memory_archive WHERE id = ?').run(id);
  // INSERT OR IGNORE would NOT swallow the FK violation here — the guarded EXISTS is what makes
  // this a clean false instead of a throw that takes the whole backfill down.
  assert.equal(upsertArchiveVector(id, bagOfWords('too late'), MODEL, DIMS), false);
  assert.equal(
    Number((stmt('SELECT count(*) AS n FROM memory_archive_embeddings WHERE archive_id = ?').get(id) as { n: number }).n),
    0,
  );
});

test("backfill aborts a handle's writes when the forget epoch moved mid-batch", async () => {
  const h = freshHandle();
  const keep = freshHandle();
  const base = Date.now();
  seedRow(h, 'forget this while it embeds', base + 1);
  seedRow(h, 'and this one too', base + 2);
  seedRow(keep, 'an unrelated handle keeps its vector', base + 3);

  // The /forget lands DURING the embedding call — exactly the window the fence exists for.
  const racing: Embedder = async (texts, ctx) => {
    if (ctx.handle === h) bumpForgetEpoch(h);
    return texts.map(bagOfWords);
  };
  await withEmbedder(racing, async () => {
    const res = await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 1 });
    assert.equal(res.embedded, 1, 'only the unrelated handle was written');
    assert.equal(res.skipped, 2);
    assert.deepEqual(vectorIdsFor(h), [], 'nothing was written from content a forget just wiped');
    assert.equal(vectorIdsFor(keep).length, 1);
  })();
  await purgeArchiveFor({ handle: h });
  await purgeArchiveFor({ handle: keep });
});

test('REGRESSION: purgeArchiveFor leaves ZERO vectors for the purged handle and chat', withEmbedder(fakeEmbedder(), async () => {
  const h = freshHandle();
  const keep = freshHandle();
  const chat = `chat-purge-vec-${seq}`;
  seedRow(h, 'a handle-scoped memory', Date.now() + 1);
  seedRow(null, 'a chat-scoped memory with no handle', Date.now() + 2, chat);
  seedRow(keep, 'someone else entirely', Date.now() + 3);
  await backfillArchiveEmbeddings({ batchSize: 50, maxBatches: 1 });
  assert.equal(vectorCount() >= 3, true);

  await purgeArchiveFor({ handle: h, chatId: chat });
  assert.deepEqual(vectorIdsFor(h), []);
  assert.equal(
    Number((stmt(
      `SELECT count(*) AS n FROM memory_archive_embeddings e
       JOIN memory_archive a ON a.id = e.archive_id WHERE a.chat_id = ?`
    ).get(chat) as { n: number }).n),
    0,
    'the chat-scoped vector went with its row',
  );
  assert.equal(vectorIdsFor(keep).length, 1, "another handle's vector is untouched");
  await purgeArchiveFor({ handle: keep });
}));

test('REGRESSION: the per-handle cap eviction cascades vectors away', async () => {
  const h = freshHandle();
  const db = getDb();
  const insert = stmt(
    `INSERT INTO memory_archive (agent_handle, source, content, meta_json, created_at, archived_at)
     VALUES (?, 'message_pruned', ?, '{}', ?, ?)`
  );
  db.exec('BEGIN');
  let oldestId = 0;
  for (let i = 0; i < ARCHIVE_MAX_ROWS_PER_HANDLE; i++) {
    const res = insert.run(h, `row ${i}`, i + 1, i + 1);
    if (i === 0) oldestId = Number(res.lastInsertRowid);
  }
  db.exec('COMMIT');
  assert.equal(upsertArchiveVector(oldestId, bagOfWords('the oldest row'), MODEL, DIMS), true);

  // One more insert trips the cap and evicts row 0 — its vector must go with it.
  await archiveEntries([{ source: 'short_expired', agentHandle: h, content: 'the newest thing they said' }]);
  assert.equal(
    Number((stmt('SELECT count(*) AS n FROM memory_archive_embeddings WHERE archive_id = ?').get(oldestId) as { n: number }).n),
    0,
    'the evicted row took its vector with it',
  );
  await purgeArchiveFor({ handle: h });
});

test('REGRESSION: sweepArchiveCaps cascades vectors away', async () => {
  const h = freshHandle();
  const db = getDb();
  const insert = stmt(
    `INSERT INTO memory_archive (agent_handle, source, content, meta_json, created_at, archived_at)
     VALUES (?, 'message_pruned', ?, '{}', ?, ?)`
  );
  db.exec('BEGIN');
  const oldestIds: number[] = [];
  for (let i = 0; i < ARCHIVE_MAX_ROWS_PER_HANDLE + 3; i++) {
    const res = insert.run(h, `row ${i}`, i + 1, i + 1);
    if (i < 3) oldestIds.push(Number(res.lastInsertRowid));
  }
  db.exec('COMMIT');
  for (const id of oldestIds) assert.equal(upsertArchiveVector(id, bagOfWords(`row ${id}`), MODEL, DIMS), true);

  assert.equal(await sweepArchiveCaps(), 3);
  for (const id of oldestIds) {
    assert.equal(
      Number((stmt('SELECT count(*) AS n FROM memory_archive_embeddings WHERE archive_id = ?').get(id) as { n: number }).n),
      0,
    );
  }
  await purgeArchiveFor({ handle: h });
});

test('deleteVectorsForScope drops by handle and by chat without touching the archive rows', withEmbedder(fakeEmbedder(), async () => {
  const h = freshHandle();
  seedRow(h, 'still archived, just no longer vectorized', Date.now());
  await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 1 });
  assert.equal(vectorIdsFor(h).length, 1);
  assert.equal(deleteVectorsForScope({ handle: h }), 1);
  assert.deepEqual(vectorIdsFor(h), []);
  assert.equal(
    Number((stmt('SELECT count(*) AS n FROM memory_archive WHERE agent_handle = ?').get(h) as { n: number }).n),
    1,
    'the archive row itself survives',
  );
  await purgeArchiveFor({ handle: h });
}));

test('the scan ignores vectors whose model or dims disagree with the query', withEmbedder(fakeEmbedder(), async () => {
  const h = freshHandle();
  const good = seedRow(h, 'the boston marathon training plan', Date.now() + 1);
  const wrongModel = seedRow(h, 'the boston marathon training plan, again', Date.now() + 2);
  upsertArchiveVector(good, bagOfWords('the boston marathon training plan'), MODEL, DIMS);
  stmt(
    `INSERT OR REPLACE INTO memory_archive_embeddings (archive_id, vector, dims, model, created_at)
     VALUES (?, ?, ?, 'test/other-embed', ?)`
  ).run(wrongModel, encodeVector(bagOfWords('the boston marathon training plan, again')), DIMS, Date.now());

  const hits = vectorCandidates(
    bagOfWords('the boston marathon training plan'),
    '(a.agent_handle = ?)', [h],
    { candidates: 100, topK: 10, minScore: 0.1, model: MODEL, dims: DIMS },
  );
  assert.deepEqual(hits.map(x => x.id), [good]);
  assert.ok(hits[0].score > 0.9);
  assert.equal(embeddingsDims(), DIMS);
  await purgeArchiveFor({ handle: h });
}));

test('with no embedder registered the backfill is a no-op that still reports the backlog', async () => {
  assert.equal(archiveEmbedder(), null);
  const h = freshHandle();
  seedRow(h, 'nobody is going to embed this', Date.now());
  const res = await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 1 });
  assert.deepEqual({ embedded: res.embedded, batches: res.batches }, { embedded: 0, batches: 0 });
  assert.ok(res.remaining >= 1);
  await purgeArchiveFor({ handle: h });
});

// LAST: it wipes every table.
test('resetStorageForTests clears the vector table', () => {
  const id = seedRow(freshHandle(), 'about to be reset away', Date.now());
  assert.equal(upsertArchiveVector(id, bagOfWords('reset me'), MODEL, DIMS), true);
  assert.ok(vectorCount() > 0);
  resetStorageForTests();
  assert.equal(vectorCount(), 0);
});
