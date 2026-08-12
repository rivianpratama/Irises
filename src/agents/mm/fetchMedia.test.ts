import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchVerified } from './fetchMedia.js';
import type { MediaFetchOutcome } from '../../llm/inlineMedia.js';
import type { ExtractedMedia } from '../../webhook/types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/agents/mm/fetchMedia.test.ts

const ok = (): MediaFetchOutcome => ({ ok: true, media: { base64: 'QUJD', mime: 'image/jpeg', bytes: 3 } });
const http = (status: number): MediaFetchOutcome => ({ ok: false, failure: 'http', status });
const oversize = (): MediaFetchOutcome => ({ ok: false, failure: 'oversize', bytes: 99 });
const network = (): MediaFetchOutcome => ({ ok: false, failure: 'network' });

const media = (over: Partial<ExtractedMedia> = {}): ExtractedMedia =>
  ({ url: 'https://cdn.linqapp.com/x.jpg', mimeType: 'image/jpeg', ...over });

/** A fetchMedia stub that returns each queued outcome in order, recording the URLs it was called with. */
function queued(...outcomes: MediaFetchOutcome[]) {
  const calls: string[] = [];
  const fetchMedia = async (url: string): Promise<MediaFetchOutcome> => {
    calls.push(url);
    return outcomes.shift() ?? network();
  };
  return { fetchMedia, calls };
}

test('success on the first fetch never re-signs', async () => {
  const { fetchMedia, calls } = queued(ok());
  let freshCalled = false;
  const r = await fetchVerified(media({ attachmentId: 'att1' }), {
    fetchMedia, getFreshUrl: async () => { freshCalled = true; return 'https://fresh'; },
  });
  assert.equal(r.ok, true);
  assert.equal(freshCalled, false);
  assert.equal(calls.length, 1);
});

test('HTTP 403 with an attachmentId re-signs once and succeeds on the fresh URL', async () => {
  const { fetchMedia, calls } = queued(http(403), ok());
  const r = await fetchVerified(media({ attachmentId: 'att1' }), {
    fetchMedia, getFreshUrl: async () => 'https://cdn.linqapp.com/fresh.jpg',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['https://cdn.linqapp.com/x.jpg', 'https://cdn.linqapp.com/fresh.jpg']);
});

test('HTTP 403 with no fresh URL available → expired', async () => {
  const { fetchMedia } = queued(http(403));
  const r = await fetchVerified(media({ attachmentId: 'att1' }), { fetchMedia, getFreshUrl: async () => null });
  assert.deepEqual(r, { ok: false, reason: 'expired' });
});

test('HTTP 404 on the re-signed URL too → expired', async () => {
  const { fetchMedia } = queued(http(403), http(404));
  const r = await fetchVerified(media({ attachmentId: 'att1' }), { fetchMedia, getFreshUrl: async () => 'https://fresh' });
  assert.deepEqual(r, { ok: false, reason: 'expired' });
});

test('HTTP 500 → unfetchable (server hiccup, not an expiry)', async () => {
  const { fetchMedia } = queued(http(500));
  const r = await fetchVerified(media(), { fetchMedia, getFreshUrl: async () => null });
  assert.deepEqual(r, { ok: false, reason: 'unfetchable' });
});

test('a network error → unfetchable', async () => {
  const { fetchMedia } = queued(network());
  const r = await fetchVerified(media(), { fetchMedia, getFreshUrl: async () => null });
  assert.deepEqual(r, { ok: false, reason: 'unfetchable' });
});

test('oversize never re-signs (a fresh signature does not shrink the file)', async () => {
  const { fetchMedia, calls } = queued(oversize());
  let freshCalled = false;
  const r = await fetchVerified(media({ attachmentId: 'att1' }), {
    fetchMedia, getFreshUrl: async () => { freshCalled = true; return 'https://fresh'; },
  });
  assert.deepEqual(r, { ok: false, reason: 'oversize' });
  assert.equal(freshCalled, false);
  assert.equal(calls.length, 1);
});

test('oversize on the re-signed URL → oversize', async () => {
  const { fetchMedia } = queued(http(403), oversize());
  const r = await fetchVerified(media({ attachmentId: 'att1' }), { fetchMedia, getFreshUrl: async () => 'https://fresh' });
  assert.deepEqual(r, { ok: false, reason: 'oversize' });
});

test('no attachmentId → no re-sign, reason taken from the first attempt', async () => {
  const { fetchMedia, calls } = queued(http(403));
  let freshCalled = false;
  const r = await fetchVerified(media(), {
    fetchMedia, getFreshUrl: async () => { freshCalled = true; return 'https://fresh'; },
  });
  assert.deepEqual(r, { ok: false, reason: 'expired' });
  assert.equal(freshCalled, false);
  assert.equal(calls.length, 1);
});

test('a re-signed URL identical to the original is not retried', async () => {
  const { fetchMedia, calls } = queued(http(403));
  const r = await fetchVerified(media({ url: 'https://same', attachmentId: 'att1' }), {
    fetchMedia, getFreshUrl: async () => 'https://same',
  });
  assert.deepEqual(r, { ok: false, reason: 'expired' });
  assert.equal(calls.length, 1);
});
