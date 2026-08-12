import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMediaBlocks, fetchMediaDetailed, fetchMediaAsBase64, type FetchedMedia } from './inlineMedia.js';
import type { LlmRequest } from './types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/llm/inlineMedia.test.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const fetched = (base64: string, mime: string): FetchedMedia => ({ base64, mime, bytes: base64.length });

test('a remote audio URL gains inlined data + a mapped format; text is untouched', async () => {
  const req: LlmRequest = {
    role: 'mm',
    messages: [{ role: 'user', content: [
      { type: 'audio', url: 'https://cdn.example.com/vm.m4a', mimeType: 'audio/mp4' },
      { type: 'text', text: 'whats this' },
    ] }],
  };
  const out = await inlineMediaBlocks(req, async () => fetched('QUJD', 'audio/mp4'));
  const content = out.messages[0].content as Any[];
  assert.equal(content[0].type, 'audio');
  assert.equal(content[0].data, 'QUJD');
  assert.equal(content[0].format, 'm4a');          // audio/mp4 → m4a via formatFromMime
  assert.equal(content[1].text, 'whats this');
});

test('a remote video URL gains inlined data and the resolved mimeType', async () => {
  const req: LlmRequest = {
    role: 'mm',
    messages: [{ role: 'user', content: [{ type: 'video', url: 'https://cdn.example.com/clip', mimeType: 'video/mp4' }] }],
  };
  const out = await inlineMediaBlocks(req, async () => fetched('VklE', 'video/mp4'));
  const block = (out.messages[0].content as Any[])[0];
  assert.equal(block.type, 'video');
  assert.equal(block.data, 'VklE');
  assert.equal(block.mimeType, 'video/mp4');
});

test('an audio/video block that already carries data is left as-is and the fetcher is not called', async () => {
  let called = false;
  const spy = async () => { called = true; return fetched('NEW', 'audio/mp4'); };
  const req: LlmRequest = {
    role: 'mm',
    messages: [{ role: 'user', content: [{ type: 'audio', mimeType: 'audio/mp4', data: 'OLD', format: 'm4a' }] }],
  };
  const out = await inlineMediaBlocks(req, spy);
  assert.equal(called, false);
  assert.equal((out.messages[0].content as Any[])[0].data, 'OLD');
});

test('a fetch/size failure DROPS the media block but keeps sibling text', async () => {
  const req: LlmRequest = {
    role: 'mm',
    messages: [{ role: 'user', content: [
      { type: 'video', url: 'https://cdn/huge.mp4', mimeType: 'video/mp4' },
      { type: 'text', text: 'look at this' },
    ] }],
  };
  const out = await inlineMediaBlocks(req, async () => null); // simulates fetch fail or over-size cap
  const content = out.messages[0].content as Any[];
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.notEqual(out, req); // touched → a new object
});

test('images/text/document blocks are untouched (handled elsewhere / already base64)', async () => {
  const req: LlmRequest = {
    role: 'mm',
    messages: [{ role: 'user', content: [
      { type: 'image', url: 'https://cdn/x.jpg' },
      { type: 'document', mediaType: 'application/pdf', data: 'UERG' },
    ] }],
  };
  const out = await inlineMediaBlocks(req, async () => fetched('X', 'audio/mp4'));
  assert.equal(out, req); // no audio/video → same object reference (no needless clone)
});

test('plain-string content is passed through unchanged', async () => {
  const req: LlmRequest = { role: 'mm', messages: [{ role: 'user', content: 'just text' }] };
  const out = await inlineMediaBlocks(req, async () => fetched('X', 'audio/mp4'));
  assert.equal(out.messages[0].content, 'just text');
});

// ── fetchMediaDetailed — typed failures (stubs the global fetch) ──────────────────────────────

function stubFetch(impl: () => unknown) {
  const orig = globalThis.fetch;
  (globalThis as Any).fetch = async () => impl();
  return () => { globalThis.fetch = orig; };
}
const resp = (over: Record<string, unknown> = {}): Any => ({
  ok: true,
  status: 200,
  headers: { get: () => 'image/jpeg' },
  arrayBuffer: async () => new TextEncoder().encode('abc').buffer,
  ...over,
});

test('fetchMediaDetailed: a 200 returns base64 + the resolved content-type mime', async () => {
  const restore = stubFetch(() => resp());
  const out = await fetchMediaDetailed('https://cdn/x.jpg', 'image/png');
  restore();
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.media.mime, 'image/jpeg'); // from the content-type header, not the fallback
    assert.equal(Buffer.from(out.media.base64, 'base64').toString(), 'abc');
  }
});

test('fetchMediaDetailed: a non-OK response → typed http failure carrying the status', async () => {
  const restore = stubFetch(() => resp({ ok: false, status: 403 }));
  const out = await fetchMediaDetailed('https://cdn/x.jpg', 'image/jpeg');
  restore();
  assert.deepEqual(out, { ok: false, failure: 'http', status: 403 });
});

test('fetchMediaDetailed: a thrown fetch → network failure', async () => {
  const restore = stubFetch(() => { throw new Error('boom'); });
  const out = await fetchMediaDetailed('https://cdn/x.jpg', 'image/jpeg');
  restore();
  assert.deepEqual(out, { ok: false, failure: 'network' });
});

test('fetchMediaDetailed: over the byte cap → typed oversize failure', async () => {
  const big = 11 * 1024 * 1024; // default MAX_MEDIA_BYTES is 10MB
  const restore = stubFetch(() => resp({ arrayBuffer: async () => new ArrayBuffer(big) }));
  const out = await fetchMediaDetailed('https://cdn/big.jpg', 'image/jpeg');
  restore();
  assert.deepEqual(out, { ok: false, failure: 'oversize', bytes: big });
});

test('fetchMediaAsBase64 wrapper still returns null on any failure (back-compat)', async () => {
  const restore = stubFetch(() => resp({ ok: false, status: 404 }));
  const out = await fetchMediaAsBase64('https://cdn/x.jpg', 'image/jpeg');
  restore();
  assert.equal(out, null);
});
