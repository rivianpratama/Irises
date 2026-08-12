process.env.TZ = 'UTC';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/burstMerge.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBurst, splitBurstBySender, BurstInputMessage } from './burstMerge.js';
import { emptyMedia } from '../webhook/types.js';

const msg = (over: Partial<BurstInputMessage>): BurstInputMessage => ({
  from: '+15550001111', text: '', messageId: 'm', media: emptyMedia(), ...over,
});

test('preserves every text-bearing message id and numbers the manifest in order', () => {
  const r = mergeBurst([
    msg({ text: 'pull comps on 412 maple', messageId: 'm1' }),
    msg({ text: 'and who owns it', messageId: 'm2' }),
    msg({ text: 'thanks', messageId: 'm3' }),
  ]);
  assert.deepEqual(r.incomingMessageIds, ['m1', 'm2', 'm3']); // the fix: no ids discarded
  assert.deepEqual(r.manifest, [
    { text: 'pull comps on 412 maple', handle: '+15550001111', receivedAt: 0 },
    { text: 'and who owns it', handle: '+15550001111', receivedAt: 0 },
    { text: 'thanks', handle: '+15550001111', receivedAt: 0 },
  ]);
  assert.equal(r.combinedText, 'pull comps on 412 maple\n\nand who owns it\n\nthanks');
  assert.equal(r.lastMessageId, 'm3');
});

test('single message: combinedText is byte-identical to the plain text (non-burst unchanged)', () => {
  const r = mergeBurst([msg({ text: 'hey whats the option deadline', messageId: 'm1' })]);
  assert.equal(r.combinedText, 'hey whats the option deadline');
  assert.deepEqual(r.incomingMessageIds, ['m1']);
  assert.equal(r.manifest.length, 1);
});

test('takes the EARLIEST non-null reply-target / effect across the burst', () => {
  const r = mergeBurst([
    msg({ text: 'a', messageId: 'm1', incomingReplyTo: { message_id: 'x' } }),
    msg({ text: 'b', messageId: 'm2', incomingReplyTo: { message_id: 'y' }, incomingEffect: { type: 'bubble', name: 'slam' } }),
  ]);
  assert.deepEqual(r.incomingReplyTo, { message_id: 'x' });          // earliest wins
  assert.deepEqual(r.incomingEffect, { type: 'bubble', name: 'slam' }); // only m2 had one
});

test('earliestReceivedAt is the min arrival time (or 0 when none are stamped)', () => {
  const withTimes = mergeBurst([
    msg({ text: 'a', messageId: 'm1', receivedAt: 5000 }),
    msg({ text: 'b', messageId: 'm2', receivedAt: 4000 }),
    msg({ text: 'c', messageId: 'm3', receivedAt: 7000 }),
  ]);
  assert.equal(withTimes.earliestReceivedAt, 4000);
  const noTimes = mergeBurst([msg({ text: 'a', messageId: 'm1' })]);
  assert.equal(noTimes.earliestReceivedAt, 0);
});

test('manifest carries each message\'s own receivedAt (0 when unstamped), in order', () => {
  const r = mergeBurst([
    msg({ text: 'first', messageId: 'm1', receivedAt: 5000 }),
    msg({ text: 'second', messageId: 'm2', receivedAt: 6000 }),
    msg({ text: 'no stamp', messageId: 'm3' }),
  ]);
  assert.deepEqual(r.manifest.map(e => e.receivedAt), [5000, 6000, 0]);
});

test('drain re-merge (batch + late arrivals) keeps per-message receivedAt and updates earliest', () => {
  const batch = [msg({ text: 'first', messageId: 'm1', receivedAt: 5000 })];
  const late = [msg({ text: 'late one', messageId: 'm2', receivedAt: 8000 })];
  // Mirrors index.ts drain: mergeBurst runs again over the combined array.
  const r = mergeBurst([...batch, ...late]);
  assert.deepEqual(r.incomingMessageIds, ['m1', 'm2']);
  assert.deepEqual(r.manifest.map(e => e.receivedAt), [5000, 8000]);
  assert.equal(r.earliestReceivedAt, 5000);
});

test('a text-less (media-only) message is excluded from the manifest/ids but its media survives', () => {
  const r = mergeBurst([
    msg({ text: 'real ask', messageId: 'm1' }),
    msg({ text: '', messageId: 'm2', media: { images: [{ url: 'u', mimeType: 'image/png' }], audio: [], video: [], docs: [] } }),
  ]);
  assert.deepEqual(r.incomingMessageIds, ['m1']); // m2 has no text → not taggable
  assert.equal(r.manifest.length, 1);
  assert.equal(r.combinedText, 'real ask');
  assert.deepEqual(r.media.images, [{ url: 'u', mimeType: 'image/png' }]);
});

test('every media kind (image/audio/video/doc) is flat-mapped across the burst', () => {
  const r = mergeBurst([
    msg({ text: 'a', messageId: 'm1', media: { images: [{ url: 'i', mimeType: 'image/jpeg' }], audio: [{ url: 'a', mimeType: 'audio/mp4' }], video: [], docs: [] } }),
    msg({ text: '', messageId: 'm2', media: { images: [], audio: [], video: [{ url: 'v', mimeType: 'video/mp4' }], docs: [{ url: 'd', mimeType: 'application/pdf' }] } }),
  ]);
  assert.deepEqual(r.media.images, [{ url: 'i', mimeType: 'image/jpeg' }]);
  assert.deepEqual(r.media.audio, [{ url: 'a', mimeType: 'audio/mp4' }]);
  assert.deepEqual(r.media.video, [{ url: 'v', mimeType: 'video/mp4' }]);
  assert.deepEqual(r.media.docs, [{ url: 'd', mimeType: 'application/pdf' }]);
});

test('a whitespace-only message is excluded from the manifest/ids (but kept in combinedText, as before)', () => {
  const r = mergeBurst([
    msg({ text: 'real ask', messageId: 'm1' }),
    msg({ text: '   ', messageId: 'm2' }),
  ]);
  assert.deepEqual(r.incomingMessageIds, ['m1']); // trimmed-empty → not taggable
  assert.equal(r.manifest.length, 1);
  assert.equal(r.combinedText, 'real ask\n\n   '); // byte-identical to the old filter(Boolean) join
});

// ── splitBurstBySender (one turn identity per consecutive same-sender run) ────

test('splitBurstBySender: mixed senders split into ordered consecutive runs', () => {
  const A = msg({ from: '+15550001111', text: 'a1', messageId: 'a1' });
  const A2 = msg({ from: '+15550001111', text: 'a2', messageId: 'a2' });
  const B = msg({ from: '+15550002222', text: 'b1', messageId: 'b1' });
  const A3 = msg({ from: '+15550001111', text: 'a3', messageId: 'a3' });
  const runs = splitBurstBySender([A, A2, B, A3]);
  assert.equal(runs.length, 3, 'non-consecutive same sender never merges across a foreign run');
  assert.deepEqual(runs.map(r => r.map(m => m.messageId)), [['a1', 'a2'], ['b1'], ['a3']]);
  // mergeBurst on each run now has a single unambiguous identity
  assert.equal(mergeBurst(runs[0]).from, '+15550001111');
  assert.equal(mergeBurst(runs[1]).from, '+15550002222');
});

test('splitBurstBySender: a single-sender burst is ONE run (1:1 path byte-identical)', () => {
  const msgs = [msg({ text: 'x', messageId: 'm1' }), msg({ text: 'y', messageId: 'm2' })];
  const runs = splitBurstBySender(msgs);
  assert.equal(runs.length, 1);
  assert.deepEqual(mergeBurst(runs[0]), mergeBurst(msgs));
});

test('splitBurstBySender: empty input yields no runs; media-only stays in its sender run', () => {
  assert.deepEqual(splitBurstBySender([]), []);
  const A = msg({ from: '+15550001111', text: 'look', messageId: 'a1' });
  const Amedia = msg({ from: '+15550001111', text: '', messageId: 'a2', media: { images: [{ url: 'u', mimeType: 'image/jpeg' }], audio: [], video: [], docs: [] } });
  const B = msg({ from: '+15550002222', text: 'hey', messageId: 'b1' });
  const runs = splitBurstBySender([A, Amedia, B]);
  assert.deepEqual(runs.map(r => r.length), [2, 1]);
  assert.equal(mergeBurst(runs[0]).media.images.length, 1, "the media rides its sender's run");
});
