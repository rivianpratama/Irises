// Push-endpoint contract: token auth (strict equality), chatId channel validation, the size cap,
// the 202-then-deliver handoff to the injected proactive pipeline, and the optional dedupeKey/meta
// fields. Runs the real express router with supertest-free plain HTTP (node http + fetch) against an
// ephemeral port. The duplicate test wires the REAL pipeline (fake voicer + mouth) so idempotency is
// proven end to end rather than against a fake that reimplements it.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createEnginePushRouter } from './enginePush.js';
import { createProactiveDelivery, type ProactiveMessage, type ProactiveOutcome } from '../pipeline/proactiveDelivery.js';
import { registerChannel } from '../channels/registry.js';
import { webChannel } from '../channels/web/channel.js';
import { resetStorageForTests } from '../db/sqlite.js';
import type { SpeakContent, SpeakOpts, SpeakResult } from '../state/mouth.js';

registerChannel(webChannel); // so web: chatIds resolve

type Deliver = (msg: ProactiveMessage) => Promise<ProactiveOutcome>;

async function startApp(deliver: Deliver): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use(createEnginePushRouter({ deliver }));
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** A capturing fake delivery — the router's own contract is what's under test. */
function capturing(pushed: ProactiveMessage[], outcome: ProactiveOutcome = 'sent'): Deliver {
  return async msg => { pushed.push(msg); return outcome; };
}

function post(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/engine/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-engine-token': token } : {}) },
    body: JSON.stringify(body),
  });
}

/** The 202 fires before delivery completes — poll instead of a fixed beat. */
async function settle(count: () => number, want = 1): Promise<void> {
  for (let i = 0; i < 200 && count() < want; i++) await new Promise(r => setTimeout(r, 25));
}

test('token set: wrong/missing token → 403; right token → 202 and a delivery', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'sekrit';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const pushed: ProactiveMessage[] = [];
  const { server, base } = await startApp(capturing(pushed));
  t.after(() => server.close());

  assert.equal((await post(base, { chatId: 'web:debug', text: 'hi' })).status, 403);
  assert.equal((await post(base, { chatId: 'web:debug', text: 'hi' }, 'wrong')).status, 403);

  const ok = await post(base, { chatId: 'web:debug', text: 'coffee time', kind: 'reminder' }, 'sekrit');
  assert.equal(ok.status, 202);
  await settle(() => pushed.length);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].chatId, 'web:debug');
  assert.equal(pushed[0].kind, 'reminder');
  assert.equal(pushed[0].text, 'coffee time');
});

test('validation: missing fields → 400; unregistered channel prefix → 400', async (t) => {
  process.env.ENGINE_PUSH_TOKEN = 'sekrit';
  t.after(() => { delete process.env.ENGINE_PUSH_TOKEN; });
  const pushed: ProactiveMessage[] = [];
  const { server, base } = await startApp(capturing(pushed));
  t.after(() => server.close());

  assert.equal((await post(base, { chatId: 'web:debug' }, 'sekrit')).status, 400);
  assert.equal((await post(base, { text: 'x' }, 'sekrit')).status, 400);
  // An unrecognized prefix has no channel — resolveChannel throws "unroutable" → 400.
  assert.equal((await post(base, { chatId: 'bare-123', text: 'x' }, 'sekrit')).status, 400);
  // eng: parses to the bridge kind, which is not registered in this test process → 400.
  assert.equal((await post(base, { chatId: 'eng:whatsapp:123', text: 'x' }, 'sekrit')).status, 400);
  assert.equal(pushed.length, 0);
});

test('token unset: loopback allowed (dev convention, mirrors DEBUG_TOKEN)', async (t) => {
  delete process.env.ENGINE_PUSH_TOKEN;
  const pushed: ProactiveMessage[] = [];
  const { server, base } = await startApp(capturing(pushed));
  t.after(() => server.close());
  const res = await post(base, { chatId: 'web:debug', text: 'local dev push' });
  assert.equal(res.status, 202);
});

test('an unknown kind coerces to reminder; the text is capped', async (t) => {
  delete process.env.ENGINE_PUSH_TOKEN;
  const pushed: ProactiveMessage[] = [];
  const { server, base } = await startApp(capturing(pushed));
  t.after(() => server.close());

  await post(base, { chatId: 'web:debug', text: 'x', kind: 'wat' });
  await post(base, { chatId: 'web:debug', text: 'y', kind: 'memo' });
  await post(base, { chatId: 'web:debug', text: 'z'.repeat(5000) });
  await settle(() => pushed.length, 3);
  assert.deepEqual(pushed.map(m => m.kind), ['reminder', 'memo', 'reminder']);
  assert.equal(pushed[2].text.length, 4000);
});

test('dedupeKey and whitelisted meta ride through; unknown meta fields are dropped', async (t) => {
  delete process.env.ENGINE_PUSH_TOKEN;
  const pushed: ProactiveMessage[] = [];
  const { server, base } = await startApp(capturing(pushed));
  t.after(() => server.close());

  await post(base, {
    chatId: 'web:debug', text: 'the lease came in', kind: 'email',
    dedupeKey: 'job-42:fire-7',
    meta: { from: 'karen@x.com', subject: 'lease', deadlineDate: '2026-09-01', deadlineLabel: 'signing', evil: 'ignore me', nested: { a: 1 } },
  });
  await settle(() => pushed.length);
  assert.equal(pushed[0].dedupeKey, 'job-42:fire-7');
  assert.deepEqual(pushed[0].emailMeta, {
    from: 'karen@x.com', subject: 'lease', deadlineDate: '2026-09-01', deadlineLabel: 'signing',
  });

  // No meta at all → the field is simply absent.
  await post(base, { chatId: 'web:debug', text: 'plain', kind: 'memo' });
  await settle(() => pushed.length, 2);
  assert.equal(pushed[1].emailMeta, undefined);
  assert.equal(pushed[1].dedupeKey, undefined);
});

test('the engine re-POSTing the same push (its 202 never landed) delivers exactly once', async (t) => {
  delete process.env.ENGINE_PUSH_TOKEN;
  resetStorageForTests();
  const sent: string[] = [];
  const sendFollowUp = async (_chatId: string, content: SpeakContent, _opts?: SpeakOpts): Promise<SpeakResult> => {
    const text = typeof content === 'string' ? content : await content();
    if (text) sent.push(text);
    return 'sent';
  };
  // The real pipeline, with the LLM voicer swapped for a fake — dedupe is the thing under test.
  const proactive = createProactiveDelivery({ sendFollowUp, voice: async p => `voiced:${p.text}` });
  const { server, base } = await startApp(proactive.deliver);
  t.after(() => server.close());

  await post(base, { chatId: 'web:debug', text: 'standup in 10', kind: 'reminder' });
  await settle(() => sent.length);
  await post(base, { chatId: 'web:debug', text: 'standup in 10', kind: 'reminder' });
  // Give the second push room to (not) deliver.
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(sent, ['voiced:standup in 10']);
});
