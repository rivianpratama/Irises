// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Turn persistence on SQLite: latest-per-key upsert, per-turn history rows,
// the windowed sidebar seed (listHistoryKeys), search, and the size guard.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { saveLatestTurn, listPersistedTurns } from './diagnosticTurns.js';
import {
  saveTurnToHistory, listTurnHistory, listFullTurnHistory, getHistoricalTurn,
  listHistoryKeys, searchHistory,
} from './diagnosticTurnHistory.js';
import { resetStorageForTests } from '../sqlite.js';
import type { Turn } from '../../diagnostics/turns.js';

beforeEach(() => resetStorageForTests());

function turn(over: Partial<Turn>): Turn {
  const at = Date.now();
  return {
    id: 't1.a', key: 'chat-1', source: 'user', startedAt: at - 500, lastAt: at,
    eventCount: 1, agents: ['convo'], open: false,
    events: [{ id: 1, ts: at, type: 'llm', label: 'convo', response: 'ok' }],
    ...over,
  } as Turn;
}

test('saveLatestTurn upserts one row per key; listPersistedTurns seeds newest-first', async () => {
  await saveLatestTurn(turn({ key: 'k1', id: 't1.a' }));
  await saveLatestTurn(turn({ key: 'k1', id: 't2.a', trigger: 'newer' }));
  await saveLatestTurn(turn({ key: 'k2', id: 't1.b' }));
  const rows = await listPersistedTurns();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.key === 'k1')!.turn.id, 't2.a');
});

test('history: one row per (key, turn_id); full turns come back oldest-first', async () => {
  await saveTurnToHistory(turn({ key: 'k1', id: 't1', lastAt: Date.now() - 2000 }));
  await saveTurnToHistory(turn({ key: 'k1', id: 't2', lastAt: Date.now() - 1000 }));
  await saveTurnToHistory(turn({ key: 'k1', id: 't2', lastAt: Date.now() }));  // upsert, not dup
  const metas = await listTurnHistory({ key: 'k1' });
  assert.deepEqual(metas.map(m => m.turnId), ['t2', 't1']);
  const full = await listFullTurnHistory('k1');
  assert.deepEqual(full.map(t => t.id), ['t1', 't2']);
  assert.equal((await getHistoricalTurn('k1', 't1'))?.id, 't1');
  assert.equal(await getHistoricalTurn('k1', 'nope'), null);
});

test('raw wire payloads are stripped from history rows at save time', async () => {
  const t = turn({ key: 'k1', id: 't1' });
  (t.events[0] as { raw?: unknown }).raw = { huge: 'wire body' };
  await saveTurnToHistory(t);
  const stored = await getHistoricalTurn('k1', 't1');
  assert.equal((stored!.events[0] as { raw?: unknown }).raw, undefined);
});

test('listHistoryKeys: latest meta per key, real counts, partition-wide handle fallback', async () => {
  const base = Date.now();
  await saveTurnToHistory(turn({ key: 'k1', id: 't1', source: 'user', handle: 'sam', lastAt: base - 2000 }));
  await saveTurnToHistory(turn({ key: 'k1', id: 't2', source: 'system', handle: null as unknown as string, chatId: null as unknown as string, lastAt: base }));
  await saveTurnToHistory(turn({ key: 'k2', id: 't1', source: 'user', lastAt: base - 1000 }));
  const keys = await listHistoryKeys();
  assert.deepEqual(keys.map(k => k.key), ['k1', 'k2']);
  const k1 = keys[0];
  assert.equal(k1.turnId, 't2');           // newest turn is the representative
  assert.equal(k1.turnCount, 2);
  assert.equal(k1.userTurnCount, 1);
  assert.equal(k1.handle, 'sam');          // fell back to the partition-wide handle
});

test('searchHistory: meta fast path, deep payload scan, agent filter', async () => {
  await saveTurnToHistory(turn({ key: 'alpha', id: 't1', trigger: 'find the gate code', agents: ['convo'] }));
  await saveTurnToHistory(turn({
    key: 'beta', id: 't1', trigger: 'unrelated', agents: ['ops'],
    events: [{ id: 1, ts: Date.now(), type: 'llm', label: 'ops', response: 'needle-in-payload' }],
  } as Partial<Turn>));
  assert.deepEqual((await searchHistory({ q: 'gate code' })).map(m => m.key), ['alpha']);
  assert.deepEqual((await searchHistory({ q: 'needle-in-payload' })).map(m => m.key), []);          // fast path: meta only
  assert.deepEqual((await searchHistory({ q: 'needle-in-payload', deep: true })).map(m => m.key), ['beta']);
  assert.deepEqual((await searchHistory({ agent: 'ops' })).map(m => m.key), ['beta']);
});
