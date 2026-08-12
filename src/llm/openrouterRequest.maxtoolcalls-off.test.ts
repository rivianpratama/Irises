import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRequest } from './types.js';

// OPENROUTER_MAX_TOOL_CALLS_DEFAULT=0 is the emergency lever / opt-out: the field is omitted
// entirely on web-search-off requests (falls back to OpenRouter's own default). Own process so the
// module-load read of the env sees the 0.
process.env.OPENROUTER_MAX_TOOL_CALLS_DEFAULT = '0';

test('0 omits max_tool_calls on web-search-off requests (opt-out lever)', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const req: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(buildOpenRouterParams(req).max_tool_calls, undefined);
});

test('even with the lever off, an explicit web-search cap is still applied', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const req: LlmRequest = {
    role: 'ops',
    messages: [{ role: 'user', content: 'research this' }],
    enableWebSearch: true,
    webSearchMaxUses: 3,
  };
  assert.equal(buildOpenRouterParams(req).max_tool_calls, 3);
});
