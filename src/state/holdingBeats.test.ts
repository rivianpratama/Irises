process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HOLDING_BEATS_KEPT, pushHoldingBeat, recentHoldingBeats, recordHoldingBeat } from './holdingBeats.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/holdingBeats.test.ts

test('pushHoldingBeat appends to an empty or partial history', () => {
  assert.deepEqual(pushHoldingBeat([], 'one sec'), ['one sec']);
  assert.deepEqual(pushHoldingBeat(['one sec'], 'lemme check'), ['one sec', 'lemme check']);
});

test('pushHoldingBeat caps at HOLDING_BEATS_KEPT, dropping the oldest', () => {
  assert.equal(HOLDING_BEATS_KEPT, 5);
  const full = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(pushHoldingBeat(full, 'f'), ['b', 'c', 'd', 'e', 'f']);
});

test('pushHoldingBeat moves an exact duplicate to the end instead of storing it twice', () => {
  const prev = ['a', 'b', 'c'];
  assert.deepEqual(pushHoldingBeat(prev, 'a'), ['b', 'c', 'a']);
});

test('pushHoldingBeat: a duplicate move never grows the list past the cap', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];
  const next = pushHoldingBeat(full, 'b');
  assert.deepEqual(next, ['a', 'c', 'd', 'e', 'b']);
  assert.equal(next.length, HOLDING_BEATS_KEPT);
});

test('recentHoldingBeats: [] for a chat with no history', async () => {
  const chatId = randomUUID();
  assert.deepEqual(await recentHoldingBeats(chatId), []);
});

test('recordHoldingBeat: read → push → write round-trips through the preference store', async () => {
  const chatId = randomUUID();
  await recordHoldingBeat(chatId, 'one sec, looking that up');
  await recordHoldingBeat(chatId, 'hold on');
  assert.deepEqual(await recentHoldingBeats(chatId), ['one sec, looking that up', 'hold on']);
});
