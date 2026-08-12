// Run with: npm test   (TZ=UTC tsx --test)
// The Judge's "flagged important but said nothing" taxonomy. This event is the only trace of a
// suppressed surfacing, so the cause it carries is what someone reads months later to decide
// whether they're looking at a format slip or a token starve — and a starve is the one that
// re-fails identically on retry. Pure fn, no LLM, no DB.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { surfacingFailureCause } from './client.js';

const res = (over: { text?: string | null; truncated?: boolean } = {}) => ({
  text: over.text ?? null,
  truncated: over.truncated ?? false,
});

test('no envelope + no text + TRUNCATED reads as a token starve, not an empty reply', () => {
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res({ truncated: true })), 'token-starved');
  // Whitespace-only is still "no text" — a cap hit mid-first-token looks exactly like this.
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res({ text: '  \n ', truncated: true })), 'token-starved');
});

test('no envelope + no text + budget intact stays no-text', () => {
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res()), 'no-text');
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res({ text: '' })), 'no-text');
});

test('a validated envelope with nothing in it is empty-envelope, truncated or not', () => {
  // The envelope parsed, so the model DID produce the shape — a bubble-less/tool-only reply is a
  // deliberate silence, and it must not be relabelled a starve just because the cap was also hit.
  assert.equal(surfacingFailureCause({ wasEnvelope: true }, res()), 'empty-envelope');
  assert.equal(surfacingFailureCause({ wasEnvelope: true }, res({ truncated: true })), 'empty-envelope');
  assert.equal(surfacingFailureCause({ wasEnvelope: true }, res({ text: '{"bubbles":[]}' })), 'empty-envelope');
});

test('non-envelope prose is prose-dropped — it existed, the send boundary refused it', () => {
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res({ text: 'sure, here you go' })), 'prose-dropped');
  // Truncated prose is still prose we refused to ship, not a starve: something WAS written.
  assert.equal(surfacingFailureCause({ wasEnvelope: false }, res({ text: 'sure, here y', truncated: true })), 'prose-dropped');
});
