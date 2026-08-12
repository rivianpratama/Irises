import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicContent } from './callLLM.js';
import type { LlmContentBlock } from './types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/llm/toAnthropicContent.test.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test('a data: image URL becomes a base64 source (Anthropic cannot read data: via url source)', () => {
  const blocks: LlmContentBlock[] = [{ type: 'image', url: 'data:image/png;base64,QUJD', mimeType: 'image/png' }];
  const out = toAnthropicContent(blocks) as Any[];
  assert.equal(out[0].type, 'image');
  assert.deepEqual(out[0].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' });
});

test('a real remote image URL stays a url source', () => {
  const blocks: LlmContentBlock[] = [{ type: 'image', url: 'https://cdn.linqapp.com/x.jpg' }];
  const out = toAnthropicContent(blocks) as Any[];
  assert.deepEqual(out[0].source, { type: 'url', url: 'https://cdn.linqapp.com/x.jpg' });
});

test('a plain string is passed through unchanged', () => {
  assert.equal(toAnthropicContent('hello'), 'hello');
});
