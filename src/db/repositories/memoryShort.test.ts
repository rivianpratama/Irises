// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Exercises the short-term (24h) memory tier: TTL read filter, kind/chat scoping,
// task-id dedupe (the at-most-once partial-unique index), force-expiry, and the
// sweep's grace window.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addShortTerm, listShortTerm, latestShortTerm, expireShortTermNow, sweepExpiredShortTerm,
  deleteShortTermForHandle, SHORT_TTL_MS, SHORT_CONTENT_MAX_CHARS,
} from './memoryShort.js';
import { listArchiveFor, purgeArchiveFor, searchArchive } from './memoryArchive.js';
import { stmt } from '../sqlite.js';

const HANDLE = '+15550002222';

function reset() {
  stmt('DELETE FROM memory_short WHERE agent_handle = ?').run(HANDLE);
}

test('addShortTerm + listShortTerm round-trip, newest first, default 24h expiry', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', request: 'comps for maplewood', content: 'three comps found', taskId: 't1' });
  await new Promise(r => setTimeout(r, 5)); // distinct createdAt — ordering must not rely on tie-break luck
  await addShortTerm({ agentHandle: HANDLE, kind: 'media_analysis', request: 'read the contract', content: 'contract says closing 8/1', taskId: 't2' });

  const list = await listShortTerm(HANDLE);
  assert.equal(list.length, 2);
  assert.equal(list[0].taskId, 't2'); // newest first
  assert.equal(list[1].taskId, 't1');
  assert.ok(list[0].expiresAt - list[0].createdAt === SHORT_TTL_MS);
});

test('expired entries are filtered at read time', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'stale', taskId: 'old', ttlMs: -1000 });
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'fresh', taskId: 'new' });
  const list = await listShortTerm(HANDLE);
  assert.deepEqual(list.map(e => e.taskId), ['new']);
});

test('kind and chat scoping filters', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, chatId: 'chat-a', kind: 'ops_research', content: 'r1', taskId: 'r1' });
  await addShortTerm({ agentHandle: HANDLE, chatId: 'chat-b', kind: 'email_flag', content: 'f1', taskId: 'f1' });

  assert.deepEqual((await listShortTerm(HANDLE, { kinds: ['email_flag'] })).map(e => e.taskId), ['f1']);
  assert.deepEqual((await listShortTerm(HANDLE, { chatId: 'chat-a' })).map(e => e.taskId), ['r1']);
});

test('same (kind, taskId) re-insert is a no-op (retrying pipeline safety)', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'email_flag', content: 'flag once', taskId: 'email-9' });
  await addShortTerm({ agentHandle: HANDLE, kind: 'email_flag', content: 'flag twice', taskId: 'email-9' });
  const list = await listShortTerm(HANDLE);
  assert.equal(list.length, 1);
  assert.equal(list[0].content, 'flag once'); // first write wins
});

test('latestShortTerm spans kinds and respects recency', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'older', taskId: 'a' });
  await new Promise(r => setTimeout(r, 5));
  await addShortTerm({ agentHandle: HANDLE, kind: 'media_analysis', content: 'newer', taskId: 'b' });
  const latest = await latestShortTerm(HANDLE, ['ops_research', 'media_analysis']);
  assert.equal(latest?.taskId, 'b');
  assert.equal(await latestShortTerm(HANDLE, ['email_flag']), null);
});

test('expireShortTermNow force-expires (optionally by kind)', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'email_flag', content: 'flag', taskId: 'f' });
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'research', taskId: 'r' });
  await expireShortTermNow(HANDLE, ['email_flag']);
  assert.deepEqual((await listShortTerm(HANDLE)).map(e => e.taskId), ['r']);
  await expireShortTermNow(HANDLE);
  assert.equal((await listShortTerm(HANDLE)).length, 0);
});

test('sweep deletes only rows past expiry+grace (a daily review still sees a full day)', async () => {
  reset();
  // Expired 3 days ago — well past the 48h grace.
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'ancient', taskId: 'x', ttlMs: -3 * 24 * 60 * 60 * 1000 });
  // Expired 1h ago — inside the grace window; invisible to reads but must survive the sweep.
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'graced', taskId: 'y', ttlMs: -60 * 60 * 1000 });
  // Live.
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'live', taskId: 'z' });

  const removed = await sweepExpiredShortTerm();
  assert.equal(removed, 1);
  // Raw rows: the graced entry is invisible to reads but physically present.
  const raw = stmt('SELECT task_id FROM memory_short WHERE agent_handle = ?').all(HANDLE) as unknown as Array<{ task_id: string }>;
  assert.deepEqual(raw.map(r => r.task_id).sort(), ['y', 'z']);
  // Reads still only show the live row.
  assert.deepEqual((await listShortTerm(HANDLE)).map(e => e.taskId), ['z']);
});

test('the sweep ARCHIVES what it deletes (a day\'s findings stay searchable)', async () => {
  reset();
  await purgeArchiveFor({ handle: HANDLE });
  await addShortTerm({
    agentHandle: HANDLE, chatId: 'chat-sweep', kind: 'ops_research',
    request: 'what did the inspector say about the roof',
    content: 'the inspector flagged three cracked tiles on the north slope',
    meta: { taskId: 'ignored' }, taskId: 'sweep-1',
    ttlMs: -3 * 24 * 60 * 60 * 1000,   // well past expiry + grace
  });
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'still live', taskId: 'live-1' });

  assert.equal(await sweepExpiredShortTerm(), 1);
  const archived = await listArchiveFor(HANDLE);
  assert.equal(archived.length, 1, 'only the swept row was archived');
  assert.equal(archived[0].source, 'short_expired');
  assert.equal(archived[0].kind, 'ops_research');
  assert.equal(archived[0].chatId, 'chat-sweep');
  assert.match(archived[0].request!, /inspector/);
  assert.equal(archived[0].meta.taskId, 'sweep-1');
  // And it is reachable by the words in it — the whole point of archiving it.
  assert.equal((await searchArchive({ query: 'cracked tiles', handle: HANDLE })).length, 1);
  await purgeArchiveFor({ handle: HANDLE });
});

test('deleteShortTermForHandle hard-deletes (a /forget must not archive on the way out)', async () => {
  reset();
  await purgeArchiveFor({ handle: HANDLE });
  await addShortTerm({ agentHandle: HANDLE, kind: 'email_flag', content: 'forget this flag', taskId: 'f1' });
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'and this research', taskId: 'r1' });
  const other = '+15550003333';
  await addShortTerm({ agentHandle: other, kind: 'ops_research', content: 'someone else', taskId: 'o1' });

  assert.equal(await deleteShortTermForHandle(HANDLE), 2);
  const raw = stmt('SELECT count(*) AS n FROM memory_short WHERE agent_handle = ?').get(HANDLE) as { n: number };
  assert.equal(raw.n, 0, 'gone from the table, not merely expired');
  assert.equal((await listArchiveFor(HANDLE)).length, 0, 'and NOT archived — that would be a forget leak');
  assert.equal((await listShortTerm(other)).length, 1, 'another handle is untouched');
  // A later sweep has nothing left to archive for them.
  await sweepExpiredShortTerm();
  assert.equal((await listArchiveFor(HANDLE)).length, 0);
});

test('content is capped at SHORT_CONTENT_MAX_CHARS', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'x'.repeat(SHORT_CONTENT_MAX_CHARS + 500), taskId: 'big' });
  const [entry] = await listShortTerm(HANDLE);
  assert.equal(entry.content.length, SHORT_CONTENT_MAX_CHARS);
});
