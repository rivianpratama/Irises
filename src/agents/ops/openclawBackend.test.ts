// OpenClaw adapter contract tests — DI-injected createClient (repo convention: no module mocks).
// Focus: the bridge outbound `send` RPC (params match the gateway's SendParamsSchema: closed
// object, `to` + `idempotencyKey` required) and the drop-and-redial behavior on transport errors.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawBackend } from './openclawBackend.js';
import { EngineUnavailableError } from './engineBackend.js';

type Call = { method: string; params: Record<string, unknown> };

function fakeClientFactory(calls: Call[], opts: { failFirstRequest?: boolean } = {}) {
  let created = 0;
  let shouldFail = opts.failFirstRequest ?? false;
  const factory = async () => {
    created += 1;
    return {
      start() { /* connected */ },
      async request(method: string, params: Record<string, unknown>) {
        if (shouldFail) { shouldFail = false; throw new Error('socket closed'); }
        calls.push({ method, params });
        return { status: 'ok' };
      },
      stop() { /* noop */ },
    };
  };
  return { factory, createdCount: () => created };
}

test('channelSend: send RPC carries to/channel/message + required idempotencyKey; thread/reply only when set', async () => {
  const calls: Call[] = [];
  const { factory } = fakeClientFactory(calls);
  const be = new OpenClawBackend({ createClient: factory });

  await be.channelSend('whatsapp', '+1555', 'hello there');
  await be.channelSend('discord', 'chan9', 'threaded', { threadId: '7', replyToId: 'm2' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'send');
  assert.equal(calls[0].params.to, '+1555');
  assert.equal(calls[0].params.channel, 'whatsapp');
  assert.equal(calls[0].params.message, 'hello there');
  assert.ok(String(calls[0].params.idempotencyKey).length > 0, 'idempotencyKey is required by the gateway schema');
  assert.ok(!('threadId' in calls[0].params) && !('replyToId' in calls[0].params), 'optional keys omitted (closed schema)');

  assert.equal(calls[1].params.threadId, '7');
  assert.equal(calls[1].params.replyToId, 'm2');
  assert.notEqual(calls[0].params.idempotencyKey, calls[1].params.idempotencyKey, 'keys are unique per send');
});

test('channelSend: transport error → EngineUnavailableError, socket dropped, next call redials', async () => {
  const calls: Call[] = [];
  const { factory, createdCount } = fakeClientFactory(calls, { failFirstRequest: true });
  const be = new OpenClawBackend({ createClient: factory });

  await assert.rejects(be.channelSend('signal', '+1', 'x'), (e: Error) =>
    e instanceof EngineUnavailableError && /channel send failed/.test(e.message));
  assert.equal(createdCount(), 1);

  await be.channelSend('signal', '+1', 'retry works');
  assert.equal(createdCount(), 2, 'a fresh client was dialed after the poisoned one was dropped');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.message, 'retry works');
});
