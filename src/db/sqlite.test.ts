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

test('closeDb resets the singleton — next getDb reopens (fresh DB on :memory:)', () => {
  getDb().prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES ('c2', 'user', 'bye', ?)"
  ).run(Date.now());
  closeDb();
  const n = getDb().prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
  assert.equal(n.n, 0); // ':memory:' reopen = brand-new database
});
