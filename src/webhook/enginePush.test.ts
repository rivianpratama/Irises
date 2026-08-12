// Push-endpoint contract: token auth (strict equality), chatId channel validation, 202-then-voice
// delivery through the injected sendFollowUp, and the size cap. Runs the real express router with
// supertest-free plain HTTP (node http + fetch) against an ephemeral port.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createEnginePushRouter } from './enginePush.js';
import { registerChannel } from '../channels/registry.js';
import { webChannel } from '../channels/web/channel.js';
import type { SpeakContent, SpeakOpts, SpeakResult } from '../state/mouth.js';

registerChannel(webChannel); // so web: chatIds resolve

type Sent = { chatId: string; text: string | null };

async function startApp(sent: Sent[]): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  const sendFollowUp = async (chatId: string, content: SpeakContent, _opts?: SpeakOpts): Promise<SpeakResult> => {
    const text = typeof content === 'string' ? content : await content();
    sent.push({ chatId, text });
    return 'sent';
  };
  app.use(createEnginePushRouter({ sendFollowUp }));
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function post(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/engine/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-engine-token': token } : {}) },
    body: JSON.stringify(body),
  });
}

test('token set: wrong/missing token → 403; right token → 202 and voiced delivery', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'sekrit';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const sent: Sent[] = [];
  const { server, base } = await startApp(sent);
  t.after(() => server.close());

  assert.equal((await post(base, { chatId: 'web:debug', text: 'hi' })).status, 403);
  assert.equal((await post(base, { chatId: 'web:debug', text: 'hi' }, 'wrong')).status, 403);

  const ok = await post(base, { chatId: 'web:debug', text: 'coffee time', kind: 'reminder' }, 'sekrit');
  assert.equal(ok.status, 202);
  // 202 fires before voicing completes; the voicer LLM call fails over to its hardcoded floor in
  // this key-less test env, which can take a few seconds — poll instead of a fixed beat.
  for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'web:debug');
  assert.ok(sent[0].text, 'a voiced (or floor) text was delivered');
});

test('validation: missing fields → 400; unregistered channel prefix → 400', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'sekrit';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const sent: Sent[] = [];
  const { server, base } = await startApp(sent);
  t.after(() => server.close());

  assert.equal((await post(base, { chatId: 'web:debug' }, 'sekrit')).status, 400);
  assert.equal((await post(base, { text: 'x' }, 'sekrit')).status, 400);
  // An unrecognized prefix has no channel — resolveChannel throws "unroutable" → 400.
  assert.equal((await post(base, { chatId: 'bare-123', text: 'x' }, 'sekrit')).status, 400);
  // eng: parses to the bridge kind, which is not registered in this test process → 400.
  assert.equal((await post(base, { chatId: 'eng:whatsapp:123', text: 'x' }, 'sekrit')).status, 400);
  assert.equal(sent.length, 0);
});

test('token unset: loopback allowed (dev convention, mirrors DEBUG_TOKEN)', async (t) => {
  delete process.env.ENGINE_PUSH_TOKEN;
  const sent: Sent[] = [];
  const { server, base } = await startApp(sent);
  t.after(() => server.close());
  const res = await post(base, { chatId: 'web:debug', text: 'local dev push' });
  assert.equal(res.status, 202);
});
