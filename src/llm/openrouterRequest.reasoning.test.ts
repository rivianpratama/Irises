// Reasoning-DISABLE on the OpenRouter lane. Absence of the `reasoning` field does not mean "no
// reasoning": it means the MODEL's own default decides, and a reasoning-family model inherited onto
// every voice role (engineDiscovery's applyModel) thinks by default — spending the tiny per-call caps
// (classify's 20, the climate eval's 200, validateDirective's 20, updateDossier's 900) entirely on
// thinking, with no content token ever emitted. So a role with nothing armed now SAYS so on the wire.
// LLM_REASONING_DISABLE=off restores the old body byte for byte.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenRouterParams, buildOpenAIParams } from './openrouterRequest.js';
import type { LlmRequest } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function req(role: LlmRequest['role']): LlmRequest {
  return { role, messages: [{ role: 'user', content: 'x' }] };
}

afterEach(() => { delete process.env.LLM_REASONING_DISABLE; });

test('a role with no reasoning armed now sends reasoning: { enabled: false }', () => {
  // classify/fallfirm/convo default to thinking off + effort off (models.ts), so on a reasoning
  // model they were silently thinking. This is the field that stops it.
  for (const role of ['classify', 'fallfirm', 'convo'] as const) {
    const params = buildOpenRouterParams(req(role)) as Any;
    assert.deepEqual(params.reasoning, { enabled: false }, `${role} disables reasoning explicitly`);
  }
});

test('an ARMED role is untouched — { enabled: true, effort } exactly as before', () => {
  // ops arms both (OPS_THINKING default on, OPS_EFFORT default xhigh → capped to high).
  const params = buildOpenRouterParams(req('ops')) as Any;
  assert.deepEqual(params.reasoning, { enabled: true, effort: 'high' });
});

test('disableReasoning overrides even an armed role (what the starved retry sends)', () => {
  const params = buildOpenRouterParams(req('ops'), { disableReasoning: true }) as Any;
  assert.deepEqual(params.reasoning, { enabled: false });
});

test('LLM_REASONING_DISABLE=off omits the field entirely (today\'s body, byte for byte)', () => {
  process.env.LLM_REASONING_DISABLE = 'off';
  const params = buildOpenRouterParams(req('classify')) as Any;
  assert.equal('reasoning' in params, false, 'no field at all — the off path is the old body');
  // The armed role is unaffected by the flag either way.
  assert.deepEqual((buildOpenRouterParams(req('ops')) as Any).reasoning, { enabled: true, effort: 'high' });
});

test('the flag is read at CALL time, not at module load', () => {
  process.env.LLM_REASONING_DISABLE = 'false';
  assert.equal('reasoning' in (buildOpenRouterParams(req('classify')) as Any), false);
  delete process.env.LLM_REASONING_DISABLE;
  assert.deepEqual((buildOpenRouterParams(req('classify')) as Any).reasoning, { enabled: false });
});

test('the starved retry still sends nothing on the generic openai lane', () => {
  // `reasoning` is OpenRouter-proprietary; a stock OpenAI-compatible endpoint 400s on it. The
  // generic lane carries no reasoning field in either direction.
  const p = buildOpenAIParams(req('classify')) as Any;
  assert.equal('reasoning' in p, false);
});
