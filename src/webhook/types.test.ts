import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImageUrls, extractAudioUrls, extractDocUrls, type MessagePart } from './types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/webhook/types.test.ts

test('extractImageUrls carries attachmentId + filename through', () => {
  const parts: MessagePart[] = [
    { type: 'media', url: 'https://cdn.linqapp.com/p.jpg', mime_type: 'image/jpeg', attachment_id: 'att_1', filename: 'porch.jpg' },
  ];
  assert.deepEqual(extractImageUrls(parts), [
    { url: 'https://cdn.linqapp.com/p.jpg', mimeType: 'image/jpeg', attachmentId: 'att_1', filename: 'porch.jpg' },
  ]);
});

test('extractDocUrls carries attachmentId + filename (and defaults a missing mime)', () => {
  const parts: MessagePart[] = [
    { type: 'media', url: 'https://cdn.linqapp.com/c.pdf', attachment_id: 'att_2', filename: 'Contract.pdf' },
  ];
  assert.deepEqual(extractDocUrls(parts), [
    { url: 'https://cdn.linqapp.com/c.pdf', mimeType: 'application/octet-stream', attachmentId: 'att_2', filename: 'Contract.pdf' },
  ]);
});

test('a media part without an attachment_id still extracts (fields simply undefined — retry is skipped later)', () => {
  const parts: MessagePart[] = [{ type: 'media', url: 'https://cdn.linqapp.com/vm.m4a', mime_type: 'audio/mp4' }];
  const [got] = extractAudioUrls(parts);
  assert.equal(got.url, 'https://cdn.linqapp.com/vm.m4a');
  assert.equal(got.attachmentId, undefined);
  assert.equal(got.filename, undefined);
});
