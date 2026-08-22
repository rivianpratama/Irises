import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from './callLLM.js';
import { laneUnconfiguredError } from './laneKeys.js';
import { getRecentErrors, _test as errlog } from '../diagnostics/errorLog.js';
import type { LlmProvider, LlmRequest, LlmResult } from './types.js';

// The lane policy end to end: callLLM's real dispatch, with the provider call itself replaced (the
// `run` seam) so a keyless lane, a 400 and a fallback can all be exercised without a network.

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY'] as const;

/** Set exactly these lane keys for one test; everything else is unset. */
function setKeys(keys: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
}

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { role: 'classify', messages: [{ role: 'user', content: 'ping' }], ...overrides };
}

function ok(provider: LlmProvider): LlmResult {
  return { text: 'pong', toolCalls: [], stopReason: 'end_turn', truncated: false, provider, model: `${provider}/stub` };
}

function withStatus(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

test.beforeEach(() => {
  errlog.reset();
  errlog.setFlushFn(async () => true);   // keep the durable sink out of it; the ring is what we read
});

test.afterEach(() => {
  setKeys({});
  errlog.reset();
});

test('a keyless fallback lane is NOT attempted — the primary error is what the caller sees', async () => {
  // The reproduced bug: OPENROUTER_API_KEY set, ANTHROPIC_API_KEY set to '' (single-key deploy).
  // The 400 was a bad-model one — the class fallbackPolicy salvages TOWARD Anthropic — so it fell
  // through to the Anthropic lane, which threw "Could not resolve authentication method" from
  // inside the SDK. The caller lost the 400 and got an auth error for a key it never meant to use.
  setKeys({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: '' });
  const lanes: LlmProvider[] = [];
  const primaryErr = withStatus(400, '400 deepseek/deepseek-v4-flash:exacto is not a valid model ID');
  await assert.rejects(
    () => callLLM(req({ providerOverride: 'openrouter' }), async provider => {
      lanes.push(provider);
      throw primaryErr;
    }),
    (err: unknown) => {
      assert.equal(err, primaryErr, 'the PRIMARY error surfaces, not an auth error from the fallback leg');
      return true;
    },
  );
  assert.deepEqual(lanes, ['openrouter'], 'the keyless anthropic lane was never dispatched');
  // One warn line saying why the fallback was skipped, naming the missing var.
  const warns = getRecentErrors().filter(e => e.category === 'llm_fallback');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].severity, 'warn');
  assert.match(warns[0].message, /fallback skipped: ANTHROPIC_API_KEY not configured/);
  // …and the primary failure itself still leaves its own error trail.
  assert.equal(getRecentErrors().filter(e => e.category === 'llm_error').length, 1);
});

test('a starved primary with a keyless fallback surfaces the starvation error, not an auth error', async () => {
  // Statusless-and-retryable is the shape most likely to reach a keyless lane (every network blip
  // and every length-starve). Same rule: skip, surface the real error.
  setKeys({ OPENROUTER_API_KEY: 'sk-or-test' });
  const lanes: LlmProvider[] = [];
  const primaryErr = new Error('openrouter length-starved: model=x max_tokens=20 …');
  await assert.rejects(
    () => callLLM(req({ providerOverride: 'openrouter' }), async provider => { lanes.push(provider); throw primaryErr; }),
    (err: unknown) => err === primaryErr,
  );
  assert.deepEqual(lanes, ['openrouter']);
});

test('with BOTH lanes configured the fallback still runs (unchanged behavior)', async () => {
  setKeys({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-test' });
  const lanes: LlmProvider[] = [];
  const result = await callLLM(req({ providerOverride: 'openrouter' }), async provider => {
    lanes.push(provider);
    if (provider === 'openrouter') throw withStatus(503, 'openrouter: upstream unavailable');
    return ok(provider);
  });
  assert.deepEqual(lanes, ['openrouter', 'anthropic'], 'the transient failure was salvaged on the other lane');
  assert.equal(result.provider, 'anthropic');
  const warns = getRecentErrors().filter(e => e.category === 'llm_fallback');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /falling back to anthropic/, 'the lane switch is logged as a switch, not as a skip');
});

test('an ANTHROPIC_AUTH_TOKEN-only deploy still has a usable Anthropic fallback', async () => {
  // Blank ANTHROPIC_API_KEY does not mean "no Anthropic" when the SDK's other credential is set.
  setKeys({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'tok' });
  const lanes: LlmProvider[] = [];
  const result = await callLLM(req({ providerOverride: 'openrouter' }), async provider => {
    lanes.push(provider);
    if (provider === 'openrouter') throw withStatus(529, 'overloaded');
    return ok(provider);
  });
  assert.deepEqual(lanes, ['openrouter', 'anthropic']);
  assert.equal(result.provider, 'anthropic');
});

test('a keyless PRIMARY lane is still salvaged by the configured other lane', async () => {
  // The live single-key shape for an Anthropic-primary role (fallfirm): blank ANTHROPIC_API_KEY,
  // a real OpenRouter key. The lane's own "not configured" error is statusless and unmarked
  // precisely so this keeps working — the role answers on OpenRouter instead of going dark.
  setKeys({ ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: 'sk-or-test' });
  const lanes: LlmProvider[] = [];
  const result = await callLLM(req({ providerOverride: 'anthropic' }), async provider => {
    lanes.push(provider);
    if (provider === 'anthropic') throw laneUnconfiguredError('anthropic');
    return ok(provider);
  });
  assert.deepEqual(lanes, ['anthropic', 'openrouter']);
  assert.equal(result.provider, 'openrouter');
});

test('with NO lane configured the role fails fast, naming itself and both env vars', async () => {
  setKeys({ ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '   ' });
  let dispatched = 0;
  await assert.rejects(
    () => callLLM(req({ providerOverride: 'anthropic' }), async () => { dispatched++; return ok('anthropic'); }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /^classify:/);
      assert.match(message, /ANTHROPIC_API_KEY/);
      assert.match(message, /OPENROUTER_API_KEY/);
      return true;
    },
  );
  assert.equal(dispatched, 0, 'neither lane was dispatched — the config error precedes any call');
});

test('a keyless fallback does not add a skip warn when the error was never fallbackable', async () => {
  // A 401 fails loud on its own (fallbackPolicy). The skip line is only about a salvage that the
  // missing key prevented — otherwise every hard failure would gain a second, misleading warn.
  setKeys({ OPENROUTER_API_KEY: 'sk-or-test' });
  await assert.rejects(
    () => callLLM(req({ providerOverride: 'openrouter' }), async () => { throw withStatus(401, 'bad key'); }),
    /bad key/,
  );
  assert.equal(getRecentErrors().filter(e => e.category === 'llm_fallback').length, 0);
});
