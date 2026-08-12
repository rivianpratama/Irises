process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectInterveningUserMessages } from './interveningMessages.js';

test('includes only user messages strictly after the holding timestamp', () => {
  const holdingAt = 1000;
  const history = [
    { role: 'user', content: 'pull my pipeline', at: 900 },        // before holding -> excluded
    { role: 'assistant', content: 'pulling that now', at: 1000 },  // the holding line itself
    { role: 'user', content: 'ok thanks', at: 1200 },              // intervening -> included
    { role: 'assistant', content: 'still on it', at: 1300 },       // assistant -> excluded
    { role: 'user', content: 'no rush', at: 1500 },                // intervening -> included
  ];
  assert.deepEqual(selectInterveningUserMessages(history, holdingAt), ['ok thanks', 'no rush']);
});

test('returns empty when holdingAt is undefined (no boundary to compare against)', () => {
  assert.deepEqual(selectInterveningUserMessages([{ role: 'user', content: 'x', at: 5 }], undefined), []);
});

test('a message missing a timestamp is treated as before the boundary (excluded)', () => {
  const history = [{ role: 'user', content: 'no-at' }, { role: 'user', content: 'after', at: 2000 }];
  assert.deepEqual(selectInterveningUserMessages(history, 1000), ['after']);
});

test('blank intervening messages are dropped', () => {
  const history = [{ role: 'user', content: '   ', at: 2000 }, { role: 'user', content: 'real', at: 2001 }];
  assert.deepEqual(selectInterveningUserMessages(history, 1000), ['real']);
});
