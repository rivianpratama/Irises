// Run with: npm test   (TZ=UTC tsx --test)
// The error sink's load-bearing promises: it never throws (it lives in catch blocks on the reply
// path), storms fold into one counted row instead of one row per occurrence, the trace mirror keeps
// the dashboard's per-turn error count honest, a wedged Supabase can neither grow the heap without
// bound nor feed itself (the recursion firewall), and logDbError's 110+ call sites now land durably.
// Memory backend throughout: the repo insert no-ops, so the in-memory ring is the store.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { reportError, flushErrorLog, getRecentErrors, _test } from './errorLog.js';
import { getTraces, clearTraces } from './trace.js';
import { getTurns } from './turns.js';
import { countTurnErrors } from '../db/repositories/diagnosticTurnHistory.js';
import { logDbError } from '../db/client.js';

/** Base-26 letters — distinct fingerprints. Digit runs would normalize to '#' and FOLD. */
function alpha(n: number): string {
  let s = '';
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0);
  return s;
}

test('reporting never throws, whatever hostile shape the failure carries', () => {
  _test.reset();

  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'boom', { get() { throw new Error('getter exploded'); }, enumerable: true });

  // err is a non-Error object with no message; detail carries a circular ref, a throwing getter,
  // a bigint and a function — every JSON.stringify hazard at once.
  assert.doesNotThrow(() => reportError({
    source: 'ops',
    category: 'tool_failure',
    err: circular,
    detail: { circular, throwingGetter, big: 10n, fn: () => 1, ok: 'kept' },
  }));

  const [row] = getRecentErrors();
  assert.equal(row.source, 'ops');
  assert.equal(row.message, '[object Object]');       // String(err) — never a throw, never blank
  assert.equal(row.detail?.ok, 'kept');               // one bad key does not take the bag down
  assert.equal(row.detail?.circular, '[unserializable]');
  assert.equal(row.detail?.throwingGetter, '[unserializable]');
  assert.equal(row.count, 1);

  // An err whose toString() itself throws.
  const hostile = { toString() { throw new Error('nope'); } };
  assert.doesNotThrow(() => reportError({ source: 'ops', category: 'other', err: hostile }));
  assert.equal(getRecentErrors()[0].message, '[unstringifiable error]');

  // Oversize detail collapses to a clipped json blob rather than writing an 80KB jsonb row.
  reportError({ source: 'ops', category: 'other', message: 'huge bag', detail: { blob: 'x'.repeat(40_000) } });
  const huge = getRecentErrors()[0];
  assert.equal(huge.detail?.truncated, true);
  assert.ok(String(huge.detail?.json).length <= 8192);
});

test('a storm folds into ONE row with a count — same source/category, ids and digits normalized', () => {
  _test.reset();

  reportError({ source: 'ops', category: 'tool_failure', message: 'search_inbox_local failed for email 998877 after 3 tries', trace: false });
  reportError({ source: 'ops', category: 'tool_failure', message: 'search_inbox_local failed for email 112233 after 9 tries', trace: false });

  assert.equal(_test.queueSize(), 1, 'the second occurrence folded instead of appending');
  const [row] = getRecentErrors();
  assert.equal(row.count, 2);
  assert.ok(row.lastAt >= row.firstAt);
  assert.match(row.message, /998877/, 'the FIRST occurrence keeps its real ids — only the fingerprint normalizes');

  // Same message shape, different category ⇒ a different failure ⇒ its own row.
  reportError({ source: 'ops', category: 'timeout', message: 'search_inbox_local failed for email 998877 after 3 tries', trace: false });
  assert.equal(_test.queueSize(), 2);
});

test('the trace mirror keeps the turn error count honest, and trace:false suppresses it', () => {
  _test.reset();
  clearTraces();

  reportError({
    source: 'convo', category: 'turn_failure', message: 'the turn died before it answered',
    chatId: 'chat-errlog-1', handle: '+15550001111', detail: { scope: 'test' },
  });

  const traces = getTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].label, 'convo:turn_failure');
  assert.equal(traces[0].chatId, 'chat-errlog-1');
  assert.ok(traces[0].response?.startsWith('ERROR: '), 'the ERROR: prefix is what countTurnErrors counts');

  const turns = getTurns('chat-errlog-1');
  assert.equal(countTurnErrors(turns[turns.length - 1]), 1);

  // Sites that already recorded their own ERROR event pass trace:false so the turn's
  // error_count doesn't double-count the same failure.
  reportError({ source: 'convo', category: 'turn_failure', message: 'the quiet one', chatId: 'chat-errlog-1', trace: false });
  assert.equal(getTraces().length, 1);
  assert.equal(countTurnErrors(turns[turns.length - 1]), 1);
  clearTraces();
});

test('a wedged sink is capped at 500 held entries, and the losses are reported on recovery', async () => {
  _test.reset();
  _test.setFlushFn(async () => false);   // sink down: nothing drains, so the cap is what we measure

  for (let i = 0; i < 600; i++) {
    reportError({ source: 'ops', category: 'tool_failure', message: `tool ${alpha(i)} went sideways`, trace: false });
  }
  assert.equal(_test.queueSize(), 500, 'oldest dropped, heap bounded');

  _test.setFlushFn(async () => true);    // sink back
  await flushErrorLog(500);
  assert.equal(_test.queueSize(), 0);

  const drop = getRecentErrors(10).find(r => r.source === 'diagnostics');
  assert.ok(drop, 'recovery reports a drop counter');
  assert.equal(drop!.severity, 'warn');
  assert.match(drop!.message, /dropped 100 entries/);
  assert.equal(drop!.detail?.dropped, 100);
});

test('recursion firewall: a failing flush re-queues and reports NOTHING new', async () => {
  _test.reset();

  let calls = 0;
  _test.setFlushFn(async () => { calls++; throw new Error('supabase down'); });
  reportError({ source: 'judge', category: 'surfacing_failure', message: 'could not surface the email', trace: false });
  assert.equal(_test.queueSize(), 1);

  await flushErrorLog(200);
  assert.equal(_test.queueSize(), 1, 'the batch came back to the queue, not to /dev/null');
  assert.equal(calls, 1, 'one attempt per flush — no spin against a dead sink');

  // Same for the plain false return. Either way the queue must not GROW: growth would mean the
  // flush path reported its own failure through reportError/logDbError.
  _test.setFlushFn(async () => false);
  await flushErrorLog(200);
  assert.equal(_test.queueSize(), 1);
});

test('getRecentErrors is newest-first and honours its limit', () => {
  _test.reset();
  reportError({ source: 'linq', category: 'send_failure', message: 'first one', trace: false });
  reportError({ source: 'linq', category: 'send_failure', message: 'second one', trace: false });
  reportError({ source: 'linq', category: 'send_failure', message: 'third one', trace: false });

  assert.deepEqual(getRecentErrors().map(r => r.message), ['third one', 'second one', 'first one']);
  assert.equal(getRecentErrors(2).length, 2);
  assert.equal(getRecentErrors(2)[0].message, 'third one');
});

test('logDbError feeds the sink — one bridge covers every repository call site', () => {
  _test.reset();
  clearTraces();

  logDbError('someScope', new Error('relation "error_log" does not exist'));

  const [row] = getRecentErrors();
  assert.equal(row.source, 'db');
  assert.equal(row.category, 'db_error');
  assert.equal(row.detail?.scope, 'someScope');
  assert.match(row.message, /error_log/);
  assert.equal(typeof row.detail?.stack, 'string');
  // trace:false on the bridge: the diagnostics persistence path itself calls logDbError, so a
  // mirrored event there would try to persist the turn that just failed to persist.
  assert.equal(getTraces().length, 0);
});
