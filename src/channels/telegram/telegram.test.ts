// Telegram transport tests — DI fetchFn (repo convention), no network. Covers the allowlist and
// DMs-only gates, media extraction (file_id → getFile → URL, token never logged here), the
// polling loop's deleteWebhook-then-getUpdates order and offset advance, and the outbound split.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramUpdate, type TelegramUpdate } from './inbound.js';
import { startTelegramPolling } from './polling.js';
import { splitTelegramText } from './client.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';
import type { IncomingMedia } from '../../webhook/types.js';

type Queued = { chatId: string; from: string; text: string; media: IncomingMedia };

function deps(queued: Queued[], fetchFn?: typeof fetch) {
  const enqueueInbound: EnqueueInbound = ((_c: AgentClient, chatId: string, from: string, text: string, _mid: string, media: IncomingMedia) => {
    queued.push({ chatId, from, text, media });
  }) as EnqueueInbound;
  return { enqueueInbound, agentClient: {} as AgentClient, fetchFn };
}

function dm(over: Partial<NonNullable<TelegramUpdate['message']>> = {}): TelegramUpdate {
  return { update_id: 1, message: { message_id: 10, text: 'hi', chat: { id: 777, type: 'private' }, from: { id: 777 }, ...over } };
}

function fileFetch(): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    if (String(url).includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p.jpg' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as typeof fetch;
}

test('allowlist: only listed chat ids get through; groups always dropped', async (t) => {
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '777';
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  t.after(() => { delete process.env.TELEGRAM_ALLOWED_CHAT_IDS; delete process.env.TELEGRAM_BOT_TOKEN; });
  const queued: Queued[] = [];
  const d = deps(queued, fileFetch());

  assert.equal(await handleTelegramUpdate(dm(), d), 'queued');
  assert.equal(await handleTelegramUpdate(dm({ chat: { id: 999, type: 'private' } }), d), 'skipped_not_allowed');
  assert.equal(await handleTelegramUpdate(dm({ chat: { id: 777, type: 'group' } }), d), 'skipped_group');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].chatId, 'tg:777');
});

test('media: photo + voice map into IncomingMedia buckets with tokened file URLs', async (t) => {
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '777';
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  t.after(() => { delete process.env.TELEGRAM_ALLOWED_CHAT_IDS; delete process.env.TELEGRAM_BOT_TOKEN; });
  const queued: Queued[] = [];
  const d = deps(queued, fileFetch());

  const r = await handleTelegramUpdate(dm({
    text: undefined, caption: 'what is this',
    photo: [{ file_id: 'small' }, { file_id: 'big' }],
    voice: { file_id: 'v1', mime_type: 'audio/ogg' },
  }), d);
  assert.equal(r, 'queued');
  assert.equal(queued[0].text, 'what is this', 'caption stands in for text');
  assert.equal(queued[0].media.images.length, 1);
  assert.match(queued[0].media.images[0].url, /file\/botTESTTOKEN\/photos\/p\.jpg/);
  assert.equal(queued[0].media.audio.length, 1);
});

test('caption-less media still queues; a truly empty message is skipped', async (t) => {
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '777';
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  t.after(() => { delete process.env.TELEGRAM_ALLOWED_CHAT_IDS; delete process.env.TELEGRAM_BOT_TOKEN; });
  const queued: Queued[] = [];
  const d = deps(queued, fileFetch());
  assert.equal(await handleTelegramUpdate(dm({ text: undefined, photo: [{ file_id: 'x' }] }), d), 'queued');
  assert.equal(await handleTelegramUpdate(dm({ text: undefined }), d), 'skipped_empty');
});

test('polling: deleteWebhook fires first, then getUpdates; offset advances past handled updates', async (t) => {
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '777';
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  t.after(() => { delete process.env.TELEGRAM_ALLOWED_CHAT_IDS; delete process.env.TELEGRAM_BOT_TOKEN; });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const queued: Queued[] = [];
  let round = 0;
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: u, body });
    if (u.includes('/deleteWebhook')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'x' } }), { status: 200 });
    // one round with an update, then empty rounds — held ~5ms like a real long poll, so the loop
    // can't hot-spin the test process while we wait for the second cycle.
    await new Promise(r => setTimeout(r, 5));
    round++;
    const result = round === 1 ? [dm()] : [];
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;

  const handle = startTelegramPolling(deps(queued, fetchFn));
  for (let i = 0; i < 100 && calls.filter(c => c.url.includes('getUpdates')).length < 2; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  handle.stop();

  assert.ok(calls[0].url.includes('/deleteWebhook'), 'webhook cleared before polling');
  assert.equal(calls[0].body.drop_pending_updates, true);
  const polls = calls.filter(c => c.url.includes('/getUpdates'));
  assert.ok(polls.length >= 2);
  assert.equal(polls[1].body.offset, 2, 'offset = update_id + 1 after the first batch');
  assert.equal(queued.length, 1, 'the update reached enqueueInbound');
});

test('splitTelegramText: under the cap untouched; long text splits on whitespace under 4096', () => {
  assert.deepEqual(splitTelegramText('short'), ['short']);
  const long = `${'a'.repeat(4000)} ${'b'.repeat(4000)}`;
  const parts = splitTelegramText(long);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 4096, `part ${p.length} chars exceeds the cap`);
  assert.equal(parts.join('').replace(/\s/g, ''), long.replace(/\s/g, ''), 'no content lost');
});
