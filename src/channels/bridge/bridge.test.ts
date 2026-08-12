// Bridge channel contract: chatId parsing, registry routing, inbound auth/mapping, outbound
// dispatch through EngineBackend.channelSend (DI via resetEngineBackendCache), media bucketing,
// and group-flag propagation into getChat.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { bridgeChannel, parseBridgeChatId, noteBridgeChat } from './channel.js';
import { createBridgeInboundRouter, mapBridgeMedia } from './inboundRouter.js';
import { parseChannelKind } from '../registry.js';
import { resetEngineBackendCache, type EngineBackend } from '../../agents/ops/engineBackend.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';
import type { IncomingMedia } from '../../webhook/types.js';

test('parseBridgeChatId: valid forms parse, junk rejects', () => {
  assert.deepEqual(parseBridgeChatId('eng:whatsapp:+15551234567'), { platform: 'whatsapp', target: '+15551234567' });
  assert.deepEqual(parseBridgeChatId('eng:discord:#general:sub'), { platform: 'discord', target: '#general:sub' });
  assert.equal(parseBridgeChatId('tg:123'), null);
  assert.equal(parseBridgeChatId('eng:'), null);
  assert.equal(parseBridgeChatId('eng:whatsapp:'), null);
});

test('registry: eng: prefix routes to the bridge channel kind', () => {
  assert.equal(parseChannelKind('eng:signal:+1555'), 'bridge');
  assert.equal(parseChannelKind('web:x'), 'web');
});

test('sendMessage dispatches through the engine channelSend; malformed/engineless throw', async () => {
  const sent: Array<{ platform: string; chatId: string; text: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { throw new Error('not under test'); },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend(platform, chatId, text) { sent.push({ platform, chatId, text }); },
  };
  resetEngineBackendCache(engine);
  try {
    const res = await bridgeChannel.sendMessage('eng:whatsapp:+1555', 'hello there');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { platform: 'whatsapp', chatId: '+1555', text: 'hello there' });
    assert.equal(res.chat_id, 'eng:whatsapp:+1555');

    await assert.rejects(bridgeChannel.sendMessage('eng:broken', 'x'), /malformed/);
    resetEngineBackendCache(null);
    await assert.rejects(bridgeChannel.sendMessage('eng:whatsapp:+1555', 'x'), /no engine/);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('mapBridgeMedia buckets by mime and tolerates path-style entries', () => {
  const media = mapBridgeMedia([
    { url: 'https://x/a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' },
    { path: '/var/cache/hermes/voice.ogg', mime_type: 'audio/ogg' },
    { url: 'https://x/doc.pdf', mimeType: 'application/pdf' },
    { mimeType: 'image/png' }, // no url/path — dropped
  ]);
  assert.equal(media.images.length, 1);
  assert.equal(media.audio.length, 1);
  assert.equal(media.audio[0].url, '/var/cache/hermes/voice.ogg');
  assert.equal(media.docs.length, 1);
});

test('getChat reflects the group flag learned from inbound', async () => {
  noteBridgeChat('eng:discord:#eng', { isGroup: true, name: 'engineering' });
  const info = await bridgeChannel.getChat('eng:discord:#eng');
  assert.equal(info.is_group, true);
  assert.equal(info.display_name, 'engineering');
  const dm = await bridgeChannel.getChat('eng:signal:+1999');
  assert.equal(dm.is_group, false, 'unseen chats default to 1:1');
});

// ── inbound router over real HTTP ─────────────────────────────────────────────

type Queued = { chatId: string; from: string; text: string; messageId: string; media: IncomingMedia };

async function startApp(queued: Queued[]): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  const enqueueInbound: EnqueueInbound = ((_c: AgentClient, chatId: string, from: string, text: string, messageId: string, media: IncomingMedia) => {
    queued.push({ chatId, from, text, messageId, media });
  }) as EnqueueInbound;
  app.use(createBridgeInboundRouter({ enqueueInbound, agentClient: {} as AgentClient }));
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

function post(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/bridge/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-bridge-token': token } : {}) },
    body: JSON.stringify(body),
  });
}

test('inbound: token auth, validation, and the enqueue mapping', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'brtok';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const queued: Queued[] = [];
  const { server, base } = await startApp(queued);
  t.after(() => server.close());

  assert.equal((await post(base, { platform: 'whatsapp', chat_id: '+1555', text: 'yo' })).status, 403);
  assert.equal((await post(base, { platform: 'whatsapp', text: 'yo' }, 'brtok')).status, 400);
  assert.equal((await post(base, { platform: 'whatsapp', chat_id: '+1555' }, 'brtok')).status, 400);

  const ok = await post(base, {
    engine: 'hermes', platform: 'WhatsApp', chat_id: '+1555', sender_id: '+1555',
    sender_name: 'Riv', text: 'what is the weather', message_id: 'm1', is_group: false,
    media: [{ url: 'https://x/p.jpg', mimeType: 'image/jpeg' }],
  }, 'brtok');
  assert.equal(ok.status, 202);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].chatId, 'eng:whatsapp:+1555', 'platform is normalized lowercase');
  assert.equal(queued[0].from, 'eng:whatsapp:+1555');
  assert.equal(queued[0].text, 'what is the weather');
  assert.equal(queued[0].media.images.length, 1);
});

test('inbound: media-only turns queue; empty turns reject', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'brtok';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const queued: Queued[] = [];
  const { server, base } = await startApp(queued);
  t.after(() => server.close());

  assert.equal((await post(base, { platform: 'signal', chat_id: '+1', media: [{ url: 'u', mimeType: 'image/png' }] }, 'brtok')).status, 202);
  assert.equal((await post(base, { platform: 'signal', chat_id: '+1', text: '   ' }, 'brtok')).status, 400);
  assert.equal(queued.length, 1);
});
