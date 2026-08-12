process.env.TZ = 'UTC';
process.env.LINQ_API_TOKEN = 'test-token'; // must be set BEFORE client.js binds its module-level const

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The token is set above, at module top — that runs during module evaluation, before any hook/test
// callback. We then load client.js in a `before` hook (a dynamic import, so it binds the token that's
// already set — a static hoisted import would capture it too early, and top-level await isn't
// available under tsx's CJS transform). Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/linq/client.test.ts
let getFreshAttachmentUrl: (attachmentId: string) => Promise<string | null>;
let getMessage: (messageId: string) => Promise<import('./client.js').FetchedMessage | null>;
let sendMessage: typeof import('./client.js').sendMessage;
let startTyping: typeof import('./client.js').startTyping;
before(async () => { ({ getFreshAttachmentUrl, getMessage, sendMessage, startTyping } = await import('./client.js')); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function stubFetch(impl: () => unknown) {
  const orig = globalThis.fetch;
  (globalThis as Any).fetch = async () => impl();
  return () => { globalThis.fetch = orig; };
}
const jsonResp = (body: unknown): Any => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

test('reads a top-level {url}', async () => {
  const restore = stubFetch(() => jsonResp({ url: 'https://cdn.linqapp.com/fresh.jpg' }));
  const url = await getFreshAttachmentUrl('att1');
  restore();
  assert.equal(url, 'https://cdn.linqapp.com/fresh.jpg');
});

test('reads a nested {attachment:{url}}', async () => {
  const restore = stubFetch(() => jsonResp({ attachment: { url: 'https://cdn.linqapp.com/a.jpg' } }));
  assert.equal(await getFreshAttachmentUrl('att1'), 'https://cdn.linqapp.com/a.jpg');
  restore();
});

test('reads a nested {data:{url}}', async () => {
  const restore = stubFetch(() => jsonResp({ data: { url: 'https://cdn.linqapp.com/d.jpg' } }));
  assert.equal(await getFreshAttachmentUrl('att1'), 'https://cdn.linqapp.com/d.jpg');
  restore();
});

test('reads a {signed_url}', async () => {
  const restore = stubFetch(() => jsonResp({ signed_url: 'https://cdn.linqapp.com/s.jpg' }));
  assert.equal(await getFreshAttachmentUrl('att1'), 'https://cdn.linqapp.com/s.jpg');
  restore();
});

test('an unrecognized shape → null', async () => {
  const restore = stubFetch(() => jsonResp({ foo: 'bar' }));
  assert.equal(await getFreshAttachmentUrl('att1'), null);
  restore();
});

test('a non-http value in a known field is rejected → null', async () => {
  const restore = stubFetch(() => jsonResp({ url: '/relative/path' }));
  assert.equal(await getFreshAttachmentUrl('att1'), null);
  restore();
});

test('a non-OK response → null', async () => {
  const restore = stubFetch(() => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }));
  assert.equal(await getFreshAttachmentUrl('att1'), null);
  restore();
});

test('a thrown fetch → null (never throws)', async () => {
  const restore = stubFetch(() => { throw new Error('network down'); });
  assert.equal(await getFreshAttachmentUrl('att1'), null);
  restore();
});

// ── getMessage (live tapped-reply fallback) ──────────────────────────────────

test('getMessage maps a text message (parts joined, is_from_me, sender, sentAtMs, reply_to)', async () => {
  const restore = stubFetch(() => jsonResp({
    id: 'm1', chat_id: 'chat-a', is_from_me: false, from_handle: { handle: '+15551234' },
    parts: [{ type: 'text', value: 'line one' }, { type: 'text', value: 'line two' }],
    reply_to: { message_id: 'root-1', part_index: 0 }, created_at: '2026-07-01T10:00:00Z',
  }));
  const m = await getMessage('m1');
  restore();
  assert.deepEqual(m, {
    id: 'm1', chatId: 'chat-a', isFromMe: false, senderHandle: '+15551234',
    text: 'line one\nline two', replyTo: { message_id: 'root-1', part_index: 0 },
    sentAtMs: Date.parse('2026-07-01T10:00:00Z'),
  });
});

test('getMessage: a media-only message → placeholder text, undefined reply_to', async () => {
  const restore = stubFetch(() => jsonResp({ id: 'm2', chat_id: 'chat-a', is_from_me: true, parts: [{ type: 'media' }], created_at: '2026-07-01T10:00:00Z' }));
  const m = await getMessage('m2');
  restore();
  assert.equal(m?.text, '[a media attachment]');
  assert.equal(m?.isFromMe, true);
  assert.equal(m?.replyTo, undefined);
});

test('getMessage: a 404 → null', async () => {
  const restore = stubFetch(() => ({ ok: false, status: 404, json: async () => ({ error: { code: 2002 } }), text: async () => '' }));
  assert.equal(await getMessage('gone'), null);
  restore();
});

test('getMessage: a body missing id/chat_id → null', async () => {
  const restore = stubFetch(() => jsonResp({ parts: [{ type: 'text', value: 'orphan' }] }));
  assert.equal(await getMessage('m3'), null);
  restore();
});

test('getMessage: a thrown fetch / timeout → null (never throws)', async () => {
  const restore = stubFetch(() => { throw new Error('timeout'); });
  assert.equal(await getMessage('m4'), null);
  restore();
});

// ── Outbound timeouts (send lock protection) ─────────────────────────────────
// sendMessage/sendReaction run inside the per-chat send lock: a hung POST used to wedge that
// chat's queue forever. Every outbound call must now carry an AbortSignal.

function stubFetchCapture(impl: () => unknown) {
  const orig = globalThis.fetch;
  const captured: { init?: Any } = {};
  (globalThis as Any).fetch = async (_url: string, init: Any) => { captured.init = init; return impl(); };
  return { captured, restore: () => { globalThis.fetch = orig; } };
}
const sentResp = () => jsonResp({ chat_id: 'chat-a', message: { id: 'sent-1', parts: [], sent_at: '', delivery_status: 'sent', is_read: false } });

test('sendMessage passes an AbortSignal (timeout guard)', async () => {
  const { captured, restore } = stubFetchCapture(sentResp);
  const res = await sendMessage('chat-a', 'hello');
  restore();
  assert.ok(captured.init?.signal instanceof AbortSignal);
  assert.equal(res.message.id, 'sent-1');
});

test('sendMessage: an aborted/hung fetch propagates as a throw (turn errors, queue survives)', async () => {
  const { restore } = stubFetchCapture(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  await assert.rejects(() => sendMessage('chat-a', 'hello'), /timeout/i);
  restore();
});

test('startTyping passes an AbortSignal and swallows an abort (cosmetic, non-fatal)', async () => {
  const { captured, restore } = stubFetchCapture(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  await assert.doesNotReject(() => startTyping('chat-a'));
  restore();
  assert.ok(captured.init?.signal instanceof AbortSignal);
});
