// annotateReply folds a tapped-reply quote INTO the user message text, so the reply context
// persists in stored history and the API messages array — not just the current turn's system
// prompt. (The API rejects unknown fields on content blocks, hence inline annotation.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateReply, annotateTappedReply } from './shared.js';
import type { ResolvedReply } from '../../state/replyResolution.js';

test('no repliedToText → text passes through untouched', () => {
  assert.equal(annotateReply('how old'), 'how old');
  assert.equal(annotateReply('how old', undefined), 'how old');
});

test('prepends the quoted bubble as an inline annotation', () => {
  const out = annotateReply('how old', 'water heater is aging but still working');
  assert.equal(out, '[replying to your earlier text: "water heater is aging but still working"]\nhow old');
});

test('long quoted bubbles are truncated at 200 chars with an ellipsis', () => {
  const long = 'x'.repeat(250);
  const out = annotateReply('ok', long);
  assert.ok(out.includes(`"${'x'.repeat(200)}…"`));
  assert.ok(!out.includes('x'.repeat(201)));
});

// ── annotateTappedReply (thread-aware variant) ───────────────────────────────

test('annotateTappedReply: no resolution → passes text through', () => {
  assert.equal(annotateTappedReply('how old'), 'how old');
  assert.equal(annotateTappedReply('how old', undefined), 'how old');
});

test('annotateTappedReply: kind "assistant" is byte-identical to annotateReply', () => {
  const repliedTo: ResolvedReply = { kind: 'assistant', text: 'water heater is aging but still working' };
  assert.equal(
    annotateTappedReply('how old', repliedTo),
    annotateReply('how old', 'water heater is aging but still working'),
  );
});

test('annotateTappedReply: kind "own-thread" records the exchange root + the answer-bubble hint', () => {
  const repliedTo: ResolvedReply = { kind: 'own-thread', rootText: 'when does the deposit clear?', assistantBubbles: ['the deposit clears on the 14th'] };
  const out = annotateTappedReply('can u do a breakdown', repliedTo);
  assert.match(out, /replying within the earlier exchange that began with their message: "when does the deposit clear\?"/);
  assert.match(out, /most likely to one of your answer bubbles in that thread/);
  assert.ok(out.endsWith('\ncan u do a breakdown'));
});

test('annotateTappedReply: own-thread root is truncated at 200 chars', () => {
  const repliedTo: ResolvedReply = { kind: 'own-thread', rootText: 'y'.repeat(250), assistantBubbles: [] };
  const out = annotateTappedReply('ok', repliedTo);
  assert.ok(out.includes(`"${'y'.repeat(200)}…"`));
  assert.ok(!out.includes('y'.repeat(201)));
});

test('annotateTappedReply: kind "unresolved" marks a specific-but-unidentified target', () => {
  const out = annotateTappedReply('wdym', { kind: 'unresolved' });
  assert.match(out, /replying to a specific earlier message that could not be identified — not necessarily your latest bubbles/);
  assert.ok(out.endsWith('\nwdym'));
});

test('annotateTappedReply: an OLD (>24h) live-fetched assistant reply is dated', () => {
  const repliedTo: ResolvedReply = { kind: 'assistant', text: 'the deposit clears on the 14th', sentAtMs: Date.now() - 5 * 24 * 60 * 60 * 1000, viaLiveFetch: true };
  const out = annotateTappedReply('can u do a breakdown', repliedTo);
  assert.match(out, /^\[replying to your earlier text from .+: "the deposit clears on the 14th"\]\ncan u do a breakdown$/);
});

test('annotateTappedReply: a FRESH assistant reply stays undated (identical to annotateReply)', () => {
  const recent: ResolvedReply = { kind: 'assistant', text: 'water heater is aging', sentAtMs: Date.now() - 1000 };
  assert.equal(annotateTappedReply('how old', recent), annotateReply('how old', 'water heater is aging'));
});

test('annotateTappedReply: an OLD own-thread reply carries the date in the exchange marker', () => {
  const repliedTo: ResolvedReply = { kind: 'own-thread', rootText: 'what did the inspection find?', assistantBubbles: [], sentAtMs: Date.now() - 5 * 24 * 60 * 60 * 1000, viaLiveFetch: true };
  const out = annotateTappedReply('can u elaborate', repliedTo);
  assert.match(out, /replying within the earlier exchange from .+ that began with their message: "what did the inspection find\?"/);
});
