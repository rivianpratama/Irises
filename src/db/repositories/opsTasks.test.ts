// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The durable half of the ops registry: one row per background run, so a task a
// restart killed can still be named afterwards. Pinned here: the status CHECK, the
// terminal-status guard (nothing resurrects a lost/cancelled row), the horizon read
// that finds stranded runs, the approval-parking states, and the read that degrades
// to `false` instead of taking a reply path down with it.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertRunning,
  insertPendingApproval,
  listPendingApprovals,
  promoteToRunning,
  markRetrying,
  markLost,
  settleOpsTask,
  listStranded,
  hasRunningTask,
  sweepOldOpsTasks,
  getOpsTask,
} from './opsTasks.js';
import { closeDb, resetStorageForTests, stmt } from '../sqlite.js';

const HORIZON_MS = 300_000;

function backdateLeg(id: string, msAgo: number): void {
  stmt('UPDATE ops_tasks SET leg_started_at = ? WHERE id = ?').run(Date.now() - msAgo, id);
}

beforeEach(() => resetStorageForTests());

test('insertRunning writes a live row whose leg clock starts with it', () => {
  assert.equal(insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'when is the tax deadline' }), true);
  const row = getOpsTask('t-1');
  assert.ok(row);
  assert.equal(row.status, 'running');
  assert.equal(row.chatId, 'chat-a');
  assert.equal(row.kind, 'research');
  assert.equal(row.request, 'when is the tax deadline');
  assert.equal(row.legStartedAt, row.startedAt);
  assert.equal(row.settledAt, null);
  assert.deepEqual(row.meta, {});
});

test('the status CHECK refuses a status the code does not know', () => {
  assert.throws(() => {
    stmt(
      `INSERT INTO ops_tasks (id, chat_id, kind, request, status, started_at, leg_started_at, updated_at)
       VALUES (?, ?, ?, ?, 'banana', ?, ?, ?)`
    ).run('t-bogus', 'chat-a', 'research', 'x', Date.now(), Date.now(), Date.now());
  });
});

test('listStranded respects the horizon and skips settled rows', () => {
  insertRunning({ id: 't-fresh', chatId: 'chat-a', kind: 'research', request: 'fresh' });
  insertRunning({ id: 't-old', chatId: 'chat-a', kind: 'research', request: 'old' });
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS).map(r => r.id), []);

  backdateLeg('t-old', HORIZON_MS + 1000);
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS).map(r => r.id), ['t-old']);

  settleOpsTask('t-old', 'delivered');
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS).map(r => r.id), []);
});

test('listStranded never picks up a row parked for approval', () => {
  insertPendingApproval({ id: 't-park', chatId: 'chat-a', kind: 'research', request: 'email my landlord' }, Date.now());
  backdateLeg('t-park', HORIZON_MS + 60_000);
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS).map(r => r.id), []);
});

test('a terminal row is never overwritten by a late settle', () => {
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'x' });
  assert.equal(markLost('t-1'), true);
  assert.equal(settleOpsTask('t-1', 'delivered'), false);
  assert.equal(getOpsTask('t-1')?.status, 'lost');
});

test('markRetrying flips the status and moves the leg clock forward', () => {
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'x' });
  backdateLeg('t-1', HORIZON_MS + 1000);
  assert.equal(listStranded(Date.now(), HORIZON_MS).length, 1);

  assert.equal(markRetrying('t-1'), true);
  const row = getOpsTask('t-1');
  assert.equal(row?.status, 'retrying');
  assert.equal(listStranded(Date.now(), HORIZON_MS).length, 0, 'a fresh leg is not stranded');
  assert.ok((row?.legStartedAt ?? 0) > (row?.startedAt ?? 0) - 1);

  // A retrying row still strands once ITS leg goes past the horizon.
  backdateLeg('t-1', HORIZON_MS + 1000);
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS).map(r => r.id), ['t-1']);
});

test('markRetrying will not resurrect a settled row', () => {
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'x' });
  settleOpsTask('t-1', 'cancelled');
  assert.equal(markRetrying('t-1'), false);
  assert.equal(getOpsTask('t-1')?.status, 'cancelled');
});

test('hasRunningTask answers per chat, per freshness, and per request', () => {
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'When   is the TAX deadline' });
  const since = Date.now() - HORIZON_MS;

  assert.equal(hasRunningTask('chat-a', since), true);
  assert.equal(hasRunningTask('chat-b', since), false);
  assert.equal(hasRunningTask('chat-a', Date.now() + 1000), false, 'a row older than the window does not count');
  assert.equal(hasRunningTask('chat-a', since, 'when is the tax deadline'), true, 'whitespace/case-insensitive match');
  assert.equal(hasRunningTask('chat-a', since, 'what is the weather'), false);

  settleOpsTask('t-1', 'delivered');
  assert.equal(hasRunningTask('chat-a', since), false);
});

test('hasRunningTask counts a parked approval as not running', () => {
  insertPendingApproval({ id: 't-park', chatId: 'chat-a', kind: 'research', request: 'send it' }, Date.now());
  assert.equal(hasRunningTask('chat-a', Date.now() - HORIZON_MS), false);
});

test('a parked approval is listed, promoted, and then runs', () => {
  const askedAt = Date.now() - 5_000;
  assert.equal(insertPendingApproval({ id: 't-park', chatId: 'chat-a', kind: 'research', request: 'email my landlord', meta: { effect: 'act' } }, askedAt), true);
  insertPendingApproval({ id: 't-other', chatId: 'chat-b', kind: 'research', request: 'book a table' }, askedAt);

  const pending = listPendingApprovals('chat-a');
  assert.deepEqual(pending.map(r => r.id), ['t-park']);
  assert.equal(pending[0].status, 'pending_approval');
  assert.equal(pending[0].startedAt, askedAt);
  assert.deepEqual(pending[0].meta, { effect: 'act' });

  const startedAt = Date.now();
  assert.equal(promoteToRunning('t-park', startedAt), true);
  const row = getOpsTask('t-park');
  assert.equal(row?.status, 'running');
  assert.equal(row?.startedAt, startedAt);
  assert.equal(row?.legStartedAt, startedAt);
  assert.deepEqual(listPendingApprovals('chat-a'), []);
  assert.equal(promoteToRunning('t-park', startedAt), false, 'a running row cannot be promoted twice');
});

test('a parked approval settles as declined or expired, and then stays put', () => {
  insertPendingApproval({ id: 't-no', chatId: 'chat-a', kind: 'research', request: 'send it' }, Date.now());
  insertPendingApproval({ id: 't-old', chatId: 'chat-a', kind: 'research', request: 'post it' }, Date.now());

  assert.equal(settleOpsTask('t-no', 'declined'), true);
  assert.equal(settleOpsTask('t-old', 'expired'), true);
  assert.equal(getOpsTask('t-no')?.status, 'declined');
  assert.equal(getOpsTask('t-old')?.status, 'expired');
  assert.deepEqual(listPendingApprovals('chat-a'), []);
  assert.equal(promoteToRunning('t-no', Date.now()), false, 'a declined action never starts');
});

test('sweepOldOpsTasks deletes settled rows past the age and leaves live ones alone', async () => {
  insertRunning({ id: 't-live', chatId: 'chat-a', kind: 'research', request: 'live' });
  for (const [id, status] of [['t-d', 'delivered'], ['t-f', 'failed'], ['t-c', 'cancelled'], ['t-l', 'lost'], ['t-x', 'declined'], ['t-e', 'expired']] as const) {
    insertRunning({ id, chatId: 'chat-a', kind: 'research', request: id });
    settleOpsTask(id, status);
  }
  // Backdate every row, live one included: only the settled ones may go.
  stmt('UPDATE ops_tasks SET started_at = ?, updated_at = ?').run(Date.now() - 10 * 86_400_000, Date.now() - 10 * 86_400_000);

  assert.equal(await sweepOldOpsTasks(7 * 86_400_000), 6);
  assert.equal(getOpsTask('t-live')?.status, 'running');
  assert.equal(getOpsTask('t-d'), null);
});

test('a read whose statement throws answers false instead of taking the caller down', () => {
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'x' });
  assert.equal(hasRunningTask('chat-a', Date.now() - HORIZON_MS), true);

  // The honest way to make a statement throw under :memory:: take the table out from under it.
  // (closeDb() alone would not do it — getDb() reopens and re-runs the DDL on the next stmt().)
  stmt('DROP TABLE ops_tasks').run();
  assert.equal(hasRunningTask('chat-a', Date.now() - HORIZON_MS), false);
  assert.deepEqual(listStranded(Date.now(), HORIZON_MS), []);
  assert.deepEqual(listPendingApprovals('chat-a'), []);
  assert.equal(getOpsTask('t-1'), null);
  assert.equal(insertRunning({ id: 't-2', chatId: 'chat-a', kind: 'research', request: 'x' }), false);
  assert.equal(settleOpsTask('t-1', 'delivered'), false);

  closeDb(); // fresh connection for the next test — the DDL runs again on open
});
