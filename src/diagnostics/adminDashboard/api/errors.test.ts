// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Behavioral contract of the Errors tab's data layer, ported from the retired
// memory-driver duplicates (filterMemoryErrors/memoryErrorStats/memoryTopErrors)
// to the single SQL path both drivers now share: filter semantics of listErrors,
// grouping of getErrorStats, and fingerprint ranking of getTopErrors.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertErrorRows, listErrors, getErrorStats, getTopErrors, type StoredErrorRow,
} from '../../../db/repositories/errorLog.js';
import { resetStorageForTests, stmt } from '../../../db/sqlite.js';

let seq = 0;
function row(over: Partial<StoredErrorRow> = {}): StoredErrorRow {
  const at = over.createdAt ?? 1_000_000;
  return {
    id: 0,
    severity: 'error',
    source: 'ops',
    category: 'timeout',
    message: 'ops step exceeded budget',
    detail: null,
    chatId: null,
    handle: null,
    taskId: null,
    fingerprint: `fp-${++seq}`,
    count: 1,
    firstAt: at,
    lastAt: at,
    createdAt: at,
    ...over,
  };
}

/** Insert rows and stamp their created_at from the fixture (insertErrorRows uses now()). */
async function seed(rows: StoredErrorRow[]): Promise<void> {
  for (const r of rows) {
    await insertErrorRows([r]);
    stmt('UPDATE error_log SET created_at = ? WHERE id = (SELECT max(id) FROM error_log)').run(r.createdAt);
  }
}

beforeEach(() => resetStorageForTests());

test('listErrors matches on source, category and severity; filters AND together', async () => {
  await seed([
    row({ source: 'ops', category: 'timeout', severity: 'error' }),
    row({ source: 'judge', category: 'degraded', severity: 'warn' }),
    row({ source: 'process', category: 'process_crash', severity: 'fatal' }),
  ]);
  assert.deepEqual((await listErrors({ source: 'judge' })).map(r => r.source), ['judge']);
  assert.deepEqual((await listErrors({ category: 'timeout' })).map(r => r.category), ['timeout']);
  assert.deepEqual((await listErrors({ severity: 'fatal' })).map(r => r.severity), ['fatal']);
  assert.equal((await listErrors({ source: 'judge', severity: 'fatal' })).length, 0);
  assert.equal((await listErrors({})).length, 3);
});

test('listErrors q is a case-insensitive substring of the message only', async () => {
  await seed([
    row({ message: 'openrouter length-starved: max_tokens=100' }),
    row({ message: 'POST /chats/x/messages failed: 502 Bad Gateway', source: 'webhook' }),
  ]);
  assert.equal((await listErrors({ q: 'LENGTH-STARVED' })).length, 1);
  assert.equal((await listErrors({ q: '502' }))[0].source, 'webhook');
  // q never leaks into other columns — 'webhook' is a source, not message text.
  assert.equal((await listErrors({ q: 'webhook' })).length, 0);
});

test('listErrors windows on since/before and sorts newest first', async () => {
  await seed([
    row({ createdAt: 1000, message: 'a' }),
    row({ createdAt: 3000, message: 'b' }),
    row({ createdAt: 2000, message: 'c' }),
  ]);
  assert.deepEqual((await listErrors({})).map(r => r.message), ['b', 'c', 'a']);
  assert.deepEqual((await listErrors({ since: 2000 })).map(r => r.message), ['b', 'c']);
  // before is a cursor: strictly older, so the row AT the cursor is excluded.
  assert.deepEqual((await listErrors({ before: 3000 })).map(r => r.message), ['c', 'a']);
  assert.deepEqual((await listErrors({ since: 2000, before: 3000 })).map(r => r.message), ['c']);
});

test('listErrors clamps limit into 1..200 (default 100)', async () => {
  await seed(Array.from({ length: 250 }, (_, i) => row({ createdAt: 1000 + i })));
  assert.equal((await listErrors({ limit: 5 })).length, 5);
  assert.equal((await listErrors({ limit: 0 })).length, 1);
  assert.equal((await listErrors({ limit: 9999 })).length, 200);
  assert.equal((await listErrors({})).length, 100);
});

test('getErrorStats sums folded counts per dimension', async () => {
  await seed([
    row({ source: 'ops', category: 'timeout', severity: 'error', count: 3 }),
    row({ source: 'ops', category: 'truncation', severity: 'warn', count: 1 }),
    row({ source: 'webhook', category: 'send_failure', severity: 'error', count: 2 }),
  ]);
  const stats = await getErrorStats(0);
  const pick = (dimension: string, value: string) => stats.find(s => s.dimension === dimension && s.value === value);
  assert.deepEqual(pick('source', 'ops'), { dimension: 'source', value: 'ops', events: 4, rows: 2 });
  assert.deepEqual(pick('severity', 'error'), { dimension: 'severity', value: 'error', events: 5, rows: 2 });
  assert.deepEqual(pick('category', 'send_failure'), { dimension: 'category', value: 'send_failure', events: 2, rows: 1 });
  // The severity dimension is what the summary strip totals — it must cover every occurrence.
  const total = stats.filter(s => s.dimension === 'severity').reduce((n, s) => n + s.events, 0);
  assert.equal(total, 6);
  assert.equal((await getErrorStats(1_000_001)).length, 0);
});

test('getTopErrors ranks fingerprints by occurrences with the newest sample message', async () => {
  await seed([
    row({ fingerprint: 'aaa', message: 'older sample', count: 2, createdAt: 1000, lastAt: 1000 }),
    row({ fingerprint: 'aaa', message: 'newest sample', count: 3, createdAt: 2000, lastAt: 2000 }),
    row({ fingerprint: 'bbb', message: 'one off', count: 1, createdAt: 3000, lastAt: 3000 }),
  ]);
  const top = await getTopErrors(0);
  assert.equal(top.length, 2);
  assert.equal(top[0].fingerprint, 'aaa');
  assert.equal(top[0].events, 5);
  assert.equal(top[0].message, 'newest sample');
  assert.equal(top[0].lastAt, 2000);
  assert.equal(top[1].fingerprint, 'bbb');
  assert.equal((await getTopErrors(0, 1)).length, 1);
  assert.equal((await getTopErrors(2500)).length, 1);
});
