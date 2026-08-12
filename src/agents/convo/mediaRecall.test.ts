process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rememberMedia, recallMedia, describeAge, describeMedia } from './mediaRecall.js';
import type { IncomingMedia } from '../../webhook/types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/agents/convo/mediaRecall.test.ts

function media(over: Partial<IncomingMedia> = {}): IncomingMedia {
  return { images: [], audio: [], video: [], docs: [], ...over };
}

test('remember/recall round-trips the stashed media for the same chat', async () => {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const chatId = randomUUID();
  const m = media({ images: [{ url: 'https://cdn/x.jpg', mimeType: 'image/jpeg' }] });
  await rememberMedia(handle, chatId, m);
  const got = await recallMedia(handle, chatId);
  assert.ok(got, 'stashed media is recalled');
  assert.equal(got!.media.images.length, 1);
  assert.equal(typeof got!.at, 'number');
});

test('recall is scoped to the same conversation', async () => {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const chatId = randomUUID();
  await rememberMedia(handle, chatId, media({ docs: [{ url: 'https://cdn/c.pdf', mimeType: 'application/pdf' }] }));
  assert.equal(await recallMedia(handle, randomUUID()), null, 'a different chat recalls nothing');
});

test('describeMedia names the mix', () => {
  assert.equal(describeMedia(media({ images: [{ url: 'a', mimeType: 'image/jpeg' }] })), 'a photo');
  assert.equal(describeMedia(media({ images: [{ url: 'a', mimeType: 'i' }, { url: 'b', mimeType: 'i' }] })), '2 photos');
  assert.equal(
    describeMedia(media({ images: [{ url: 'a', mimeType: 'i' }], docs: [{ url: 'd', mimeType: 'application/pdf' }] })),
    'a photo + a document',
  );
});

test('describeAge buckets minutes → hours → a day', () => {
  assert.equal(describeAge(30_000), 'moments ago');
  assert.equal(describeAge(20 * 60_000), 'about 20 minutes ago');
  assert.equal(describeAge(60 * 60_000), 'about an hour ago');
  assert.equal(describeAge(5 * 60 * 60_000), 'about 5 hours ago');
  assert.equal(describeAge(30 * 60 * 60_000), 'about a day ago');
});
