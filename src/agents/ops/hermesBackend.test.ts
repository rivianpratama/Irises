// hermes adapter contract tests — DI-injected fetchFn (repo convention: no module mocks).
// Covers the chat-completions happy path, per-chat session headers, media mapping, error mapping
// (401/429/refused/timeout), the jobs API body shape, and the NO-ENGINE-left-behind guarantees.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesBackend, hermesSessionKey, jobPrefix, reminderJobPrompt } from './hermesBackend.js';
import { EngineUnavailableError, EngineRunError } from './engineBackend.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'web_research',
    request: 'what is new', createdAt: Date.now(), media: emptyMedia(), ...over,
  };
}

type Captured = { url: string; init: RequestInit };

/** A fetchFn returning a canned response while capturing the request. */
function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

test('runTask: happy path returns the message content and sends session headers', async () => {
  const captured: Captured[] = [];
  const be = new HermesBackend({ fetchFn: fakeFetch(200, { choices: [{ message: { content: 'ANSWER: 42\nSOURCE: web\nFLAGS: none' } }] }, captured) });
  const out = await be.runTask('the prompt', mkTask(), {});
  assert.equal(out, 'ANSWER: 42\nSOURCE: web\nFLAGS: none');
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/v1\/chat\/completions$/);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Hermes-Session-Id'], hermesSessionKey('web:debug'));
  assert.equal(headers['X-Hermes-Session-Key'], hermesSessionKey('web:debug'));
  assert.match(headers.Authorization, /^Bearer /);
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content, 'the prompt');
});

test('runTask: images become image_url content blocks; other media rides as URLs in text', async () => {
  const captured: Captured[] = [];
  const be = new HermesBackend({ fetchFn: fakeFetch(200, { choices: [{ message: { content: 'ok' } }] }, captured) });
  const media = {
    images: [{ url: 'https://cdn/x.jpg', mimeType: 'image/jpeg', filename: 'x.jpg' }],
    audio: [{ url: 'https://cdn/v.ogg', mimeType: 'audio/ogg', filename: 'memo.ogg' }],
    video: [], docs: [],
  };
  await be.runTask('look at this', mkTask({ media }), {});
  const body = JSON.parse(String(captured[0].init.body));
  const content = body.messages[0].content;
  assert.ok(Array.isArray(content), 'content is a block array when images exist');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /memo\.ogg.*https:\/\/cdn\/v\.ogg/s, 'audio URL rides in the text for engine tools');
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } });
});

test('runTask: 401 maps to needs_auth, 429 to rate_limited, refused to EngineUnavailableError', async () => {
  const be401 = new HermesBackend({ fetchFn: fakeFetch(401, { error: 'bad key' }) });
  await assert.rejects(be401.runTask('p', mkTask(), {}), (e: Error) =>
    e instanceof EngineRunError && e.failureCause === 'needs_auth');

  const be429 = new HermesBackend({ fetchFn: fakeFetch(429, { error: 'busy' }) });
  await assert.rejects(be429.runTask('p', mkTask(), {}), (e: Error) =>
    e instanceof EngineRunError && e.failureCause === 'rate_limited');

  const beDown = new HermesBackend({
    fetchFn: (async () => { throw new TypeError('fetch failed: ECONNREFUSED'); }) as typeof fetch,
  });
  await assert.rejects(beDown.runTask('p', mkTask(), {}), EngineUnavailableError);
});

test('runTask: a caller abort surfaces as AbortError (mapped to cancelled upstream)', async () => {
  const be = new HermesBackend({
    fetchFn: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }) as typeof fetch,
  });
  const ac = new AbortController();
  const p = be.runTask('p', mkTask(), { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
});

test('createReminder: one-time fireAt becomes a pinned cron with repeat:1; cron passes through', async () => {
  const captured: Captured[] = [];
  const be = new HermesBackend({ fetchFn: fakeFetch(200, { job: { id: 7, name: 'irises:web-debug:t', schedule: '0 9 12 8 *' } }, captured) });
  const ref = await be.createReminder({
    chatId: 'web:debug', agentHandle: '+1555', instruction: 'nudge them',
    fireAt: new Date('2026-08-12T09:00:00').getTime(), title: 't',
  });
  assert.equal(ref.id, '7');
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.repeat, 1, 'one-time reminders retire after firing');
  assert.match(body.name, new RegExp(`^${jobPrefix('web:debug').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(body.prompt, /api\/engine\/push/, 'the job delivers back through the Irises push endpoint');
  assert.equal(body.deliver, 'local');

  const captured2: Captured[] = [];
  const be2 = new HermesBackend({ fetchFn: fakeFetch(200, { job: { id: 8 } }, captured2) });
  await be2.createReminder({ chatId: 'c', agentHandle: 'h', instruction: 'daily', cron: '0 9 * * *' });
  assert.equal(JSON.parse(String(captured2[0].init.body)).schedule, '0 9 * * *');
});

test('listReminders scopes to this chat and strips the prefix; cancelReminder handles 404', async () => {
  const jobs = [
    { id: 1, name: `${jobPrefix('web:debug')}coffee`, schedule: '0 9 * * *' },
    { id: 2, name: `${jobPrefix('tg:999')}other-chat`, schedule: '0 9 * * *' },
    { id: 3, name: 'someone-elses-job', schedule: '* * * * *' },
  ];
  const be = new HermesBackend({ fetchFn: fakeFetch(200, { jobs }) });
  const list = await be.listReminders('web:debug');
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'coffee');

  const be404 = new HermesBackend({ fetchFn: fakeFetch(404, { error: 'gone' }) });
  assert.equal(await be404.cancelReminder('9'), false);
});

test('reminderJobPrompt names the chat, the instruction, and the push contract', () => {
  const p = reminderJobPrompt({ chatId: 'web:debug', agentHandle: 'h', instruction: 'say hi', fireAt: 1 }, 'http://127.0.0.1:3000/api/engine/push');
  assert.match(p, /web:debug/);
  assert.match(p, /say hi/);
  assert.match(p, /x-engine-token/);
  assert.match(p, /"kind": "reminder"/);
});

test('probe: ok on 200, degraded detail on non-200 and on refused', async () => {
  assert.deepEqual(await new HermesBackend({ fetchFn: fakeFetch(200, {}) }).probe(), { ok: true });
  const bad = await new HermesBackend({ fetchFn: fakeFetch(401, {}) }).probe();
  assert.equal(bad.ok, false);
  const down = await new HermesBackend({ fetchFn: (async () => { throw new TypeError('refused'); }) as typeof fetch }).probe();
  assert.equal(down.ok, false);
  assert.match(down.detail!, /not reachable/);
});
