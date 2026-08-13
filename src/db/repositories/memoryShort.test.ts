// Run with: npm test   (TZ=UTC tsx --test)
// Exercises the short-term (24h) memory tier on the in-memory backend: TTL read filter,
// kind/chat scoping, task-id dedupe (the at-most-once index emulation), force-expiry,
// and the sweep's grace window.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addShortTerm, listShortTerm, latestShortTerm, expireShortTermNow, sweepExpiredShortTerm,
  SHORT_TTL_MS, SHORT_CONTENT_MAX_CHARS,
} from './memoryShort.js';
import { mem } from '../memory.js';

const HANDLE = '+15550002222';

function reset() {
  mem.memoryShort.delete(HANDLE);
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
  const raw = mem.memoryShort.get(HANDLE) ?? [];
  assert.deepEqual(raw.map(e => e.taskId).sort(), ['y', 'z']);
  // Reads still only show the live row.
  assert.deepEqual((await listShortTerm(HANDLE)).map(e => e.taskId), ['z']);
});

test('content is capped at SHORT_CONTENT_MAX_CHARS', async () => {
  reset();
  await addShortTerm({ agentHandle: HANDLE, kind: 'ops_research', content: 'x'.repeat(SHORT_CONTENT_MAX_CHARS + 500), taskId: 'big' });
  const [entry] = await listShortTerm(HANDLE);
  assert.equal(entry.content.length, SHORT_CONTENT_MAX_CHARS);
});
