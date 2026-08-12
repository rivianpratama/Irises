process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { withChatLock, __resetSendQueues } from './sendQueue.js';

const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

test('serializes tasks per chat in FIFO order despite faster later tasks', async () => {
  __resetSendQueues();
  const order: number[] = [];
  const mk = (n: number, ms: number) => () => new Promise<void>(res => setTimeout(() => { order.push(n); res(); }, ms));
  const p1 = withChatLock('c', mk(1, 30));
  const p2 = withChatLock('c', mk(2, 5));
  const p3 = withChatLock('c', mk(3, 1));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('a rejecting send does not break the chain and never becomes an unhandled rejection', async () => {
  __resetSendQueues();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const ran: string[] = [];
    const bad = withChatLock('c', async () => { ran.push('bad'); throw new Error('transport 500'); });
    await assert.rejects(bad, /transport 500/);          // the caller can catch the real result
    const good = await withChatLock('c', async () => { ran.push('good'); return 'ok'; });
    assert.equal(good, 'ok');                        // the NEXT send still runs
    assert.deepEqual(ran, ['bad', 'good']);
    await wait(20);                                  // give any stray rejection time to surface
    assert.equal(unhandled.length, 0, 'no unhandled rejection from a throwing send');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('returns the real resolved value to the caller', async () => {
  __resetSendQueues();
  const v = await withChatLock('c', async () => 42);
  assert.equal(v, 42);
});

test('different chats are independent (not serialized against each other)', async () => {
  __resetSendQueues();
  const order: string[] = [];
  const a = withChatLock('a', () => new Promise<void>(r => setTimeout(() => { order.push('a'); r(); }, 25)));
  const b = withChatLock('b', () => new Promise<void>(r => setTimeout(() => { order.push('b'); r(); }, 1)));
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']); // b is not blocked behind a's slow task
});
