// Run with: npm test   (TZ=UTC tsx --test)
// The sqlite driver against a real file: lazy open (import creates nothing),
// WAL mode, and the restart-survival round trip the old memory backend never had.
//
// Static imports are hoisted, so the module under test is loaded via dynamic
// import() after these env assignments (see stateDir.test.ts for the full note).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'irises-disk-'));
process.env.DATA_BACKEND = 'sqlite';
process.env.IRISES_HOME = HOME;

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let sq: typeof import('./sqlite.js');
before(async () => {
  sq = await import('./sqlite.js');
});
after(() => {
  sq.closeDb();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('importing the module creates nothing — the DB appears on first getDb()', () => {
  assert.equal(fs.existsSync(path.join(HOME, 'irises.db')), false);
  sq.getDb();
  assert.equal(fs.existsSync(path.join(HOME, 'irises.db')), true);
});

test('file DBs run in WAL mode', () => {
  const mode = sq.getDb().prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(mode.journal_mode, 'wal');
});

test('rows survive close + reopen (restart survival)', () => {
  sq.getDb().prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES ('c1', 'user', 'persisted', ?)"
  ).run(1234567890);
  sq.closeDb();
  const row = sq.getDb().prepare("SELECT content, created_at FROM messages WHERE chat_id='c1'").get() as
    { content: string; created_at: number };
  assert.equal(row.content, 'persisted');
  assert.equal(row.created_at, 1234567890);
});
