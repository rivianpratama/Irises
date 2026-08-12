import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineImageBlocks } from './inlineImages.js';
import type { LlmRequest } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test('a remote image URL is rewritten to an inline base64 data URL; text is untouched', async () => {
  const req: LlmRequest = {
    role: 'convo',
    messages: [{ role: 'user', content: [
      { type: 'image', url: 'https://cdn.example.com/x.jpg' },
      { type: 'text', text: 'whats in this' },
    ] }],
  };
  const out = await inlineImageBlocks(req, async () => 'data:image/jpeg;base64,ZmFrZQ==');
  const content = out.messages[0].content as Any[];
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].url, 'data:image/jpeg;base64,ZmFrZQ==');
  assert.equal(content[1].text, 'whats in this');
});

test('an image that is already a data: URL is left as-is and the fetcher is not called', async () => {
  let called = false;
  const spy = async () => { called = true; return 'data:image/png;base64,NEW'; };
  const req: LlmRequest = { role: 'convo', messages: [{ role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,OLD' }] }] };
  const out = await inlineImageBlocks(req, spy);
  assert.equal(called, false);
  assert.equal((out.messages[0].content as Any[])[0].url, 'data:image/png;base64,OLD');
});

test('plain-string content is passed through unchanged', async () => {
  const req: LlmRequest = { role: 'convo', system: 's', messages: [{ role: 'user', content: 'just text' }] };
  const out = await inlineImageBlocks(req, async () => 'data:image/jpeg;base64,X');
  assert.equal(out.messages[0].content, 'just text');
});

test('on a fetch failure the original remote URL is kept (graceful degrade)', async () => {
  const req: LlmRequest = { role: 'convo', messages: [{ role: 'user', content: [{ type: 'image', url: 'https://cdn.example.com/x.jpg' }] }] };
  const out = await inlineImageBlocks(req, async () => null);
  assert.equal((out.messages[0].content as Any[])[0].url, 'https://cdn.example.com/x.jpg');
});

test('a request with no images returns the same object reference (no needless clone)', async () => {
  const req: LlmRequest = { role: 'convo', messages: [{ role: 'user', content: 'x' }] };
  const out = await inlineImageBlocks(req, async () => 'data:image/jpeg;base64,X');
  assert.equal(out, req);
});

test('the passed mime type is forwarded to the fetcher as the fallback', async () => {
  let seenMime: string | undefined;
  const spy = async (_url: string, mime?: string) => { seenMime = mime; return 'data:image/webp;base64,Y'; };
  const req: LlmRequest = { role: 'convo', messages: [{ role: 'user', content: [{ type: 'image', url: 'https://cdn/x', mimeType: 'image/webp' }] }] };
  await inlineImageBlocks(req, spy);
  assert.equal(seenMime, 'image/webp');
});
