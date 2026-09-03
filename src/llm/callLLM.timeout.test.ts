// The hard wall clock on one voice call, end to end through callLLM's real dispatch with the lane
// itself replaced (the `run` seam, as in callLLM.lanes.test.ts) — so "the provider never answers"
// is a promise that simply never settles, which is exactly the found failure: a local Convo call
// hung ~25 minutes on the OpenRouter lane (`agent: 1516078ms`) with no per-call bound at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from './callLLM.js';
import { LLM_CALL_TIMEOUT_DEFAULT_MS, llmCallTimeoutMs } from './openrouterRequest.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { _test as errlog } from '../diagnostics/errorLog.js';
import type { LlmProvider, LlmRequest, LlmResult } from './types.js';

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'] as const;

function setKeys(keys: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
}

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { role: 'convo', messages: [{ role: 'user', content: 'ping' }], ...overrides };
}

function ok(provider: LlmProvider): LlmResult {
  return { text: 'pong', toolCalls: [], stopReason: 'end_turn', truncated: false, provider, model: `${provider}/stub` };
}

/** A lane that never answers — and never observes the abort either, which is the point: the bound
 *  has to be ours, not the SDK's good manners. */
const NEVER = (): Promise<LlmResult> => new Promise<LlmResult>(() => { /* never settles */ });

function withTimeoutEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.LLM_CALL_TIMEOUT_MS;
  else process.env.LLM_CALL_TIMEOUT_MS = value;
}

test.beforeEach(() => {
  clearTraces();
  errlog.reset();
  errlog.setFlushFn(async () => true);
  withTimeoutEnv('40');           // 40ms stands in for the 120s default
});

test.afterEach(() => {
  setKeys({});
  withTimeoutEnv(undefined);
  errlog.reset();
});

test('llmCallTimeoutMs: default on, 0/off is the old unbounded behavior, junk keeps the bound', () => {
  assert.equal(llmCallTimeoutMs({}), LLM_CALL_TIMEOUT_DEFAULT_MS);
  assert.equal(LLM_CALL_TIMEOUT_DEFAULT_MS, 120_000);
  assert.equal(llmCallTimeoutMs({ LLM_CALL_TIMEOUT_MS: '0' }), null);
  assert.equal(llmCallTimeoutMs({ LLM_CALL_TIMEOUT_MS: 'off' }), null);
  assert.equal(llmCallTimeoutMs({ LLM_CALL_TIMEOUT_MS: 'false' }), null);
  assert.equal(llmCallTimeoutMs({ LLM_CALL_TIMEOUT_MS: '5000' }), 5_000);
  assert.equal(llmCallTimeoutMs({ LLM_CALL_TIMEOUT_MS: 'nonsense' }), LLM_CALL_TIMEOUT_DEFAULT_MS,
    'a typo must not silently remove the bound');
});

test('a voice call that never answers fails as a provider failure, with an llm:timeout receipt', async () => {
  setKeys({ ANTHROPIC_API_KEY: 'sk-ant-test' });   // one lane only: no salvage, the error surfaces
  const t0 = Date.now();
  await assert.rejects(
    () => callLLM(req({ trace: { chatId: 'c1', handle: '+1555', label: 'convo' } }), NEVER),
    (err: unknown) => {
      assert.match(String((err as Error).message), /timed out after 40ms/);
      assert.equal((err as { status?: number }).status, undefined, 'statusless, like every other transient provider failure');
      assert.notEqual((err as Error).name, 'AbortError', 'not shaped like a user cancel — that would block the salvage lane');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 2_000, 'it gave up on OUR clock, not the SDK\'s');

  const timeout = getTraces().find(e => e.label === 'llm:timeout');
  assert.ok(timeout, 'the give-up is on the record');
  assert.equal(timeout.role, 'convo');
  assert.equal((timeout.detail as { role: string }).role, 'convo');
  assert.equal((timeout.detail as { ms: number }).ms, 40);
  assert.ok(String((timeout.detail as { model: string }).model).length > 0, 'and which model kept the turn waiting');
  assert.equal(timeout.chatId, 'c1', 'filed against the chat that was left hanging');
});

test('the abort reaches the lane, so the socket is released and not just abandoned', async () => {
  setKeys({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  let seen: AbortSignal | undefined;
  await assert.rejects(() => callLLM(req(), (_p, r) => {
    seen = r.signal;
    return NEVER();
  }));
  assert.ok(seen, 'the lane was handed a signal');
  assert.equal(seen.aborted, true, 'and it was aborted when the window closed');
});

test('a hung lane still salvages on the other one — the timeout is transient, not fatal', async () => {
  setKeys({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENROUTER_API_KEY: 'sk-or-test' });
  const lanes: LlmProvider[] = [];
  const res = await callLLM(req({ providerOverride: 'openrouter' }), async (provider) => {
    lanes.push(provider);
    if (provider === 'openrouter') return NEVER();
    return ok(provider);
  });
  assert.equal(res.provider, 'anthropic', 'the second lane answered');
  assert.deepEqual(lanes, ['openrouter', 'anthropic']);
  assert.equal(getTraces().filter(e => e.label === 'llm:timeout').length, 1, 'one give-up, one receipt');
});

test('the caller\'s own cancel stays the caller\'s cancel — no timeout receipt, no salvage', async () => {
  setKeys({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENROUTER_API_KEY: 'sk-or-test' });
  const ac = new AbortController();
  const cancelled = Object.assign(new Error('Request was aborted'), { name: 'AbortError' });
  const lanes: LlmProvider[] = [];
  await assert.rejects(
    () => callLLM(req({ providerOverride: 'openrouter', signal: ac.signal }), async (provider) => {
      lanes.push(provider);
      ac.abort();
      throw cancelled;
    }),
    (err: unknown) => {
      assert.equal(err, cancelled, 'the caller\'s error, unconverted');
      return true;
    },
  );
  assert.deepEqual(lanes, ['openrouter'], 'a cancelled call must never re-bill on the other lane');
  assert.equal(getTraces().filter(e => e.label === 'llm:timeout').length, 0);
});

test('off, and on the deep-work role, the request reaches the lane UNTOUCHED', async () => {
  setKeys({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  // The byte-identical off path, stated as an identity: with no wall clock there is no derived
  // signal and no copy of the request — the lane gets the very object the caller passed.
  withTimeoutEnv('off');
  const original = req();
  let handed: LlmRequest | undefined;
  await callLLM(original, async (p, r) => { handed = r; return ok(p); });
  assert.equal(handed, original, 'same object: nothing was wrapped');
  assert.equal(handed?.signal, undefined);

  // …and the deep-work role is out of scope even with the clock on: an engine research leg is
  // bounded by the orchestrator's own per-leg deadline, not by a conversational window.
  withTimeoutEnv('40');
  const opsReq = req({ role: 'ops' });
  await callLLM(opsReq, async (p, r) => { handed = r; return ok(p); });
  assert.equal(handed, opsReq, 'the ops role is not a voice lane');
});
