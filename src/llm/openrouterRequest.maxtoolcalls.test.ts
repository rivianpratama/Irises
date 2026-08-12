import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRequest } from './types.js';

// OPENROUTER_MAX_TOOL_CALLS_DEFAULT is read at module load, so set it BEFORE the dynamic import
// (each test file runs in its own process, so this can't leak into openrouterRequest.test.ts,
// which asserts the code default of 8).
process.env.OPENROUTER_MAX_TOOL_CALLS_DEFAULT = '5';

test('the env default overrides the code default on web-search-off requests', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const req: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(buildOpenRouterParams(req).max_tool_calls, 5);
});

test('webSearchMaxUses still wins on web-search-ON requests (precedence unchanged)', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const req: LlmRequest = {
    role: 'ops',
    messages: [{ role: 'user', content: 'research this' }],
    enableWebSearch: true,
    webSearchMaxUses: 2,
  };
  assert.equal(buildOpenRouterParams(req).max_tool_calls, 2);
});
