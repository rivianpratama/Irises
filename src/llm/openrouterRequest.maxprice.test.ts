import { test } from 'node:test';
import assert from 'node:assert/strict';

// MAX_PRICE_* is read at module load, so set the env BEFORE the dynamic import. node:test runs
// each file in its own process, so this doesn't leak into the other openrouterRequest tests
// (which assert the unset-env default: no provider.max_price).
process.env.OPENROUTER_MAX_PRICE_PROMPT = '10';
process.env.OPENROUTER_MAX_PRICE_COMPLETION = '40';

test('provider.max_price attaches when the env ceilings are set', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const params = buildOpenRouterParams({ role: 'ops', messages: [{ role: 'user', content: 'x' }] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maxPrice = (params.provider as any)?.max_price;
  assert.deepEqual(maxPrice, { prompt: 10, completion: 40 });
});

test('max_price merges with jsonBubbles require_parameters instead of clobbering it', async () => {
  const { buildOpenRouterParams } = await import('./openrouterRequest.js');
  const params = buildOpenRouterParams({ role: 'convo', messages: [{ role: 'user', content: 'x' }], jsonBubbles: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = params.provider as any;
  assert.equal(provider.require_parameters, true);
  assert.deepEqual(provider.max_price, { prompt: 10, completion: 40 });
});
