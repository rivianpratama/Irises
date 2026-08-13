// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The durable error log on SQLite: batched inserts, the filter bar, and the two
// aggregate shapes whose contract the dashboard errors tab pins (dimension asc /
// events desc; newest-sample per fingerprint).
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { insertErrorRows, listErrors, getErrorStats, getTopErrors, type StoredErrorRow } from './errorLog.js';
import { resetStorageForTests } from '../sqlite.js';

beforeEach(() => resetStorageForTests());

let seq = 0;
function row(over: Partial<StoredErrorRow>): StoredErrorRow {
  const now = Date.now();
  return {
    id: 0, severity: 'error', source: 'ops', category: 'llm_error',
    message: `boom ${seq++}`, detail: null, chatId: null, handle: null, taskId: null,
    fingerprint: `fp-${seq}`, count: 1, firstAt: now, lastAt: now, createdAt: now,
    ...over,
  };
}

test('insertErrorRows batches atomically and listErrors round-trips with filters', async () => {
  assert.equal(await insertErrorRows([
    row({ source: 'convo', message: 'voicing failed', detail: { scope: 'x' } }),
    row({ source: 'ops', severity: 'warn', message: 'engine slow' }),
  ]), true);
  assert.equal(await insertErrorRows([]), true);

  const all = await listErrors({});
  assert.equal(all.length, 2);
  assert.deepEqual((await listErrors({ source: 'convo' })).map(r => r.message), ['voicing failed']);
  assert.deepEqual((await listErrors({ severity: 'warn' })).map(r => r.message), ['engine slow']);
  assert.deepEqual((await listErrors({ q: 'engine' })).map(r => r.message), ['engine slow']);
  // LIKE wildcards in user text are escaped, not interpreted
  assert.equal((await listErrors({ q: '%' })).length, 0);
  const detail = (await listErrors({ source: 'convo' }))[0].detail;
  assert.deepEqual(detail, { scope: 'x' });
});

test('getErrorStats: per-dimension rollups, events sums folded counts, contract sort', async () => {
  await insertErrorRows([
    row({ source: 'ops', category: 'timeout', severity: 'error', count: 5, fingerprint: 'a' }),
    row({ source: 'ops', category: 'llm_error', severity: 'warn', count: 2, fingerprint: 'b' }),
    row({ source: 'convo', category: 'timeout', severity: 'error', count: 1, fingerprint: 'c' }),
  ]);
  const stats = await getErrorStats(Date.now() - 60_000);
  // dimension ascending (category < severity < source), events descending inside
  assert.deepEqual(stats.map(s => s.dimension), ['category', 'category', 'severity', 'severity', 'source', 'source']);
  const cat = stats.filter(s => s.dimension === 'category');
  assert.deepEqual(cat.map(s => [s.value, s.events, s.rows]), [['timeout', 6, 2], ['llm_error', 2, 1]]);
});

test('getTopErrors: folds by fingerprint, newest sample wins, events desc', async () => {
  const old = Date.now() - 10_000;
  await insertErrorRows([
    row({ fingerprint: 'hot', message: 'older sample', count: 3, lastAt: old }),
    row({ fingerprint: 'hot', message: 'newest sample', count: 4, lastAt: old + 5000 }),
    row({ fingerprint: 'cold', message: 'rare', count: 1 }),
  ]);
  const top = await getTopErrors(Date.now() - 60_000);
  assert.equal(top[0].fingerprint, 'hot');
  assert.equal(top[0].events, 7);
  assert.equal(top[0].message, 'newest sample');
  assert.equal(top[1].fingerprint, 'cold');
});
