// Run with: npm test   (TZ=UTC tsx --test)
// The SQLite bootstrap on the ephemeral memory driver: singleton handle, DDL,
// generated columns, and the test reset seam.
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, stmt, closeDb, resetStorageForTests } from './sqlite.js';

test('getDb is a per-process singleton with the schema bootstrapped', () => {
  const a = getDb();
  const b = getDb();
  assert.equal(a, b);
  const v = a.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(v.user_version >= 1);
  // spot-check a table exists
  const row = a.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'").get();
  assert.ok(row);
});

test('token_usage.total_tokens is a stored generated column', () => {
  getDb().prepare(
    `INSERT INTO token_usage (role, provider, model, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, created_at)
     VALUES ('convo', 'anthropic', 'claude', 100, 20, 3, 7, ?)`
  ).run(Date.now());
  const row = getDb().prepare('SELECT total_tokens FROM token_usage ORDER BY id DESC LIMIT 1').get() as { total_tokens: number };
  assert.equal(row.total_tokens, 130);
});

test('stmt caches prepared statements by SQL', () => {
  const s1 = stmt('SELECT 1 AS one');
  const s2 = stmt('SELECT 1 AS one');
  assert.equal(s1, s2);
  // node:sqlite rows have a null prototype — compare fields, not whole objects
  assert.equal((s1.get() as { one: number }).one, 1);
});

test('resetStorageForTests drops rows but keeps the schema', () => {
  getDb().prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES ('c1', 'user', 'hi', ?)"
  ).run(Date.now());
  resetStorageForTests();
  const n = getDb().prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
  assert.equal(n.n, 0);
  const usage = getDb().prepare('SELECT count(*) AS n FROM token_usage').get() as { n: number };
  assert.equal(usage.n, 0);
});

test('memory_archive_embeddings cascades when its archive row is deleted', () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO memory_archive (agent_handle, source, content, meta_json, created_at, archived_at)
     VALUES ('+15550009999', 'message_pruned', 'a memory with a vector', '{}', ?, ?)`
  ).run(Date.now(), Date.now());
  const id = Number((db.prepare('SELECT id FROM memory_archive ORDER BY id DESC LIMIT 1').get() as { id: number }).id);
  db.prepare(
    `INSERT INTO memory_archive_embeddings (archive_id, vector, dims, model, created_at)
     VALUES (?, ?, 4, 'test/embed', ?)`
  ).run(id, Buffer.alloc(16), Date.now());

  // The pragma is on (getDb sets it), and this is the guard that makes a forget a forget: a
  // vector outliving its row would be a deleted memory still semantically reachable.
  db.prepare('DELETE FROM memory_archive WHERE id = ?').run(id);
  const n = db.prepare('SELECT count(*) AS n FROM memory_archive_embeddings WHERE archive_id = ?').get(id) as { n: number };
  assert.equal(n.n, 0);
});

test('closeDb resets the singleton — next getDb reopens (fresh DB on :memory:)', () => {
  getDb().prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES ('c2', 'user', 'bye', ?)"
  ).run(Date.now());
  closeDb();
  const n = getDb().prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
  assert.equal(n.n, 0); // ':memory:' reopen = brand-new database
});
