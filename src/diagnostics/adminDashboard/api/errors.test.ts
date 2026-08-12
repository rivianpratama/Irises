import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMemoryErrors, memoryErrorStats, memoryTopErrors } from './errors.js';
import type { StoredErrorRow } from '../../../db/repositories/errorLog.js';

// The Errors tab runs off two different stores — the error_log table on Supabase and
// reportError's in-process ring on the memory backend — and the view can't tell them apart.
// These cover the Node-side half: same filter semantics as listErrors, same grouping as the
// error_log_stats / error_log_top RPCs.

let seq = 0;
function row(over: Partial<StoredErrorRow> = {}): StoredErrorRow {
  const at = over.createdAt ?? 1_000_000;
  return {
    id: over.id ?? ++seq,
    severity: 'error',
    source: 'ops',
    category: 'timeout',
    message: 'ops step exceeded budget',
    detail: null,
    chatId: null,
    handle: null,
    taskId: null,
    fingerprint: 'fp-default',
    count: 1,
    firstAt: at,
    lastAt: at,
    createdAt: at,
    ...over,
  };
}

test('filterMemoryErrors matches on source, category and severity', () => {
  const rows = [
    row({ source: 'ops', category: 'timeout', severity: 'error' }),
    row({ source: 'judge', category: 'degraded', severity: 'warn' }),
    row({ source: 'process', category: 'process_crash', severity: 'fatal' }),
  ];
  assert.deepEqual(filterMemoryErrors(rows, { source: 'judge' }).map(r => r.source), ['judge']);
  assert.deepEqual(filterMemoryErrors(rows, { category: 'timeout' }).map(r => r.category), ['timeout']);
  assert.deepEqual(filterMemoryErrors(rows, { severity: 'fatal' }).map(r => r.severity), ['fatal']);
  // Filters AND together, so a mismatched pair returns nothing.
  assert.equal(filterMemoryErrors(rows, { source: 'judge', severity: 'fatal' }).length, 0);
  assert.equal(filterMemoryErrors(rows, {}).length, 3);
});

test('filterMemoryErrors q is a case-insensitive substring of the message only', () => {
  const rows = [
    row({ message: 'openrouter length-starved: max_tokens=100' }),
    row({ message: 'POST /chats/x/messages failed: 502 Bad Gateway', source: 'linq' }),
  ];
  assert.equal(filterMemoryErrors(rows, { q: 'LENGTH-STARVED' }).length, 1);
  assert.equal(filterMemoryErrors(rows, { q: '502' })[0].source, 'linq');
  // q never leaks into other columns — 'linq' is a source, not message text.
  assert.equal(filterMemoryErrors(rows, { q: 'linq' }).length, 0);
});

test('filterMemoryErrors windows on since/before and sorts newest first', () => {
  const rows = [
    row({ id: 1, createdAt: 1000 }),
    row({ id: 2, createdAt: 3000 }),
    row({ id: 3, createdAt: 2000 }),
  ];
  assert.deepEqual(filterMemoryErrors(rows, {}).map(r => r.id), [2, 3, 1]);
  assert.deepEqual(filterMemoryErrors(rows, { since: 2000 }).map(r => r.id), [2, 3]);
  // before is a cursor: strictly older, so the row AT the cursor is excluded (listErrors' .lt).
  assert.deepEqual(filterMemoryErrors(rows, { before: 3000 }).map(r => r.id), [3, 1]);
  assert.deepEqual(filterMemoryErrors(rows, { since: 2000, before: 3000 }).map(r => r.id), [3]);
});

test('filterMemoryErrors clamps limit into 1..200', () => {
  const rows = Array.from({ length: 250 }, (_, i) => row({ id: i + 1, createdAt: 1000 + i }));
  assert.equal(filterMemoryErrors(rows, { limit: 5 }).length, 5);
  assert.equal(filterMemoryErrors(rows, { limit: 0 }).length, 1);
  assert.equal(filterMemoryErrors(rows, { limit: 9999 }).length, 200);
  assert.equal(filterMemoryErrors(rows, {}).length, 100);
});

test('memoryErrorStats sums folded counts per dimension', () => {
  const rows = [
    row({ source: 'ops', category: 'timeout', severity: 'error', count: 3 }),
    row({ source: 'ops', category: 'truncation', severity: 'warn', count: 1 }),
    row({ source: 'linq', category: 'send_failure', severity: 'error', count: 2 }),
  ];
  const stats = memoryErrorStats(rows);
  const pick = (dimension: string, value: string) => stats.find(s => s.dimension === dimension && s.value === value);
  assert.deepEqual(pick('source', 'ops'), { dimension: 'source', value: 'ops', events: 4, rows: 2 });
  assert.deepEqual(pick('severity', 'error'), { dimension: 'severity', value: 'error', events: 5, rows: 2 });
  assert.deepEqual(pick('category', 'send_failure'), { dimension: 'category', value: 'send_failure', events: 2, rows: 1 });
  // The severity dimension is what the summary strip totals — it must cover every occurrence.
  const total = stats.filter(s => s.dimension === 'severity').reduce((n, s) => n + s.events, 0);
  assert.equal(total, 6);
  assert.equal(memoryErrorStats(rows, 1_000_001).length, 0);
});

test('memoryTopErrors ranks fingerprints by occurrences with the newest sample message', () => {
  const rows = [
    row({ fingerprint: 'aaa', message: 'older sample', count: 2, createdAt: 1000, lastAt: 1000 }),
    row({ fingerprint: 'aaa', message: 'newest sample', count: 3, createdAt: 2000, lastAt: 2000 }),
    row({ fingerprint: 'bbb', message: 'one off', count: 1, createdAt: 3000, lastAt: 3000 }),
  ];
  const top = memoryTopErrors(rows);
  assert.equal(top.length, 2);
  assert.equal(top[0].fingerprint, 'aaa');
  assert.equal(top[0].events, 5);
  assert.equal(top[0].message, 'newest sample');
  assert.equal(top[0].lastAt, 2000);
  assert.equal(top[1].fingerprint, 'bbb');
  assert.equal(memoryTopErrors(rows, undefined, 1).length, 1);
  assert.equal(memoryTopErrors(rows, 2500).length, 1);
});
