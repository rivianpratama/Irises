process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPendingInboundProvider, peekPendingInbound, selectUnseenPending, __resetPendingInboundProvider,
} from './inboundGlance.js';

test('peek returns [] when no provider is registered', () => {
  __resetPendingInboundProvider();
  assert.deepEqual(peekPendingInbound('c'), []);
});

test('peek delegates to the registered provider', () => {
  __resetPendingInboundProvider();
  registerPendingInboundProvider(chatId => (chatId === 'c' ? ['hey', 'also this'] : []));
  assert.deepEqual(peekPendingInbound('c'), ['hey', 'also this']);
  assert.deepEqual(peekPendingInbound('other'), []);
  __resetPendingInboundProvider();
});

test('a throwing provider degrades to [] — a glance can never break a delivery', () => {
  __resetPendingInboundProvider();
  registerPendingInboundProvider(() => { throw new Error('boom'); });
  assert.deepEqual(peekPendingInbound('c'), []);
  __resetPendingInboundProvider();
});

test('selectUnseenPending drops texts already visible in a recorded user turn', () => {
  const history = [
    { role: 'user', content: 'find the maple st contract' },
    { role: 'assistant', content: 'pulling it now' },
    // The mid-processing batch already recorded its (burst-merged, annotated) user turn:
    { role: 'user', content: '[Voice memo transcript: "hi"]\n\nwait, i meant the duplex\n\non 5th street' },
  ];
  const pending = ['wait, i meant the duplex', 'on 5th street', 'and whats the seller name'];
  assert.deepEqual(selectUnseenPending(pending, history), ['and whats the seller name']);
});

test('selectUnseenPending keeps genuinely new texts and trims empties', () => {
  const history = [
    { role: 'user', content: 'find the maple st contract' },
    { role: 'assistant', content: 'on it' },
  ];
  assert.deepEqual(selectUnseenPending(['  ', 'actually nevermind'], history), ['actually nevermind']);
});

test('selectUnseenPending never matches against assistant turns', () => {
  // Irises echoing the user's words must not make a pending text look "seen".
  const history = [{ role: 'assistant', content: 'checking the duplex on 5th now' }];
  assert.deepEqual(selectUnseenPending(['the duplex on 5th'], history), ['the duplex on 5th']);
});
