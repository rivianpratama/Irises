// Run with: npm test   (TZ=UTC tsx --test)
// renderTimestamps folds the structured LlmMessage.timestamp into wire-safe content at the
// provider boundary (both APIs reject unknown message keys).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTimestamps } from './timedMessages.js';
import type { LlmMessage } from './types.js';

test('string content gets a bracketed prefix', () => {
  const out = renderTimestamps([{ role: 'user', timestamp: '9:14 AM', content: 'hello' }]);
  assert.deepEqual(out, [{ role: 'user', content: '[9:14 AM] hello' }]);
});

test('block content gets a leading text block, original blocks untouched', () => {
  const msg: LlmMessage = {
    role: 'user',
    timestamp: 'Mon, Jul 6, 9:14 PM',
    content: [{ type: 'image', url: 'https://x/y.jpg' }, { type: 'text', text: 'hello' }],
  };
  const out = renderTimestamps([msg]);
  assert.deepEqual(out[0].content, [
    { type: 'text', text: '[Mon, Jul 6, 9:14 PM]' },
    { type: 'image', url: 'https://x/y.jpg' },
    { type: 'text', text: 'hello' },
  ]);
  assert.equal(out[0].timestamp, undefined); // never leaks toward the wire mapper
  // Input is not mutated.
  assert.equal((msg.content as unknown[]).length, 2);
});

test('untimed messages pass through untouched (same reference)', () => {
  const msg: LlmMessage = { role: 'assistant', content: 'plain brief' };
  const out = renderTimestamps([msg]);
  assert.equal(out[0], msg);
});
