// The starved retry, on the lane where starvation actually happens (the OpenAI-compatible lanes).
//
// Live evidence: `classify/llm_error: openrouter length-starved: model=deepseek/deepseek-v4-flash…
// max_tokens=200 spent the completion budget (likely on reasoning/thinking) with no content`,
// followed by `memory/classifier_failure: relationship climate eval failed — no drift applied`. The
// engine's reasoning model is inherited onto every voice role, so the classify lane's tiny per-call
// caps (200 for the climate eval, 20 for validateDirective, 900 for the dossier) go to thinking and
// the reply arrives empty. Today that throws straight to the cross-lane fallback; now it takes ONE
// same-lane retry with a real budget and reasoning off, which is the cheap fix that actually lands.
//
// No network, no key: the SDK call is injected (the `send` seam on callOpenAICompatible), so this
// exercises the REAL request shaping, the REAL detector and the REAL retry policy.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAICompatible, callLLM, type ChatSender } from './callLLM.js';
import { isStarvedError } from './truncation.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { updateRelationshipClimate, __resetClimateInFlightForTests, __resetClimateBackoffForTests } from '../memory/climateDrift.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getRelationshipClimate } from '../db/repositories/relationshipClimate.js';
import { _test as errlog } from '../diagnostics/errorLog.js';
import type { LlmRequest, LlmProvider } from './types.js';
import type { StoredMessage } from '../db/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** One fake OpenAI-compatible completion. `finish: 'length'` + null content IS the starvation shape. */
function reply(over: { content?: string | null; finish?: string } = {}): Any {
  return {
    id: 'cmpl-fake', object: 'chat.completion', created: 0, model: 'fake/reasoner',
    choices: [{
      index: 0,
      finish_reason: over.finish ?? 'stop',
      logprobs: null,
      message: { role: 'assistant', content: over.content === undefined ? 'pong' : over.content, refusal: null },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
const starved = (): Any => reply({ content: null, finish: 'length' });

/** A sender that hands out `replies` in order (an Error entry is thrown) and records every body. */
function sender(replies: Any[]): { send: ChatSender; sent: Any[] } {
  const sent: Any[] = [];
  const send = (async (params: Any) => {
    sent.push(params);
    const next = replies[sent.length - 1];
    assert.ok(next !== undefined, `unexpected extra send (#${sent.length})`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as ChatSender;
  return { send, sent };
}

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { role: 'classify', maxTokens: 200, messages: [{ role: 'user', content: 'ping' }], ...overrides };
}

function receipts(): Array<Record<string, unknown>> {
  return getTraces().filter(e => e.label === 'llm:starved_retry').map(e => e.detail as Record<string, unknown>);
}

beforeEach(() => {
  clearTraces();
  errlog.reset();
  errlog.setFlushFn(async () => true);
});

afterEach(() => {
  delete process.env.LLM_STARVED_RETRY;
  errlog.reset();
});

test('a starved 200-cap classify call retries ONCE at 600 with reasoning disabled, and succeeds', async () => {
  const { send, sent } = sender([starved(), reply({ content: '{"ease":1}' })]);
  const result = await callOpenAICompatible(req(), 'openrouter', send);

  assert.equal(sent.length, 2, 'exactly one retry');
  assert.equal(sent[0].max_tokens, 200, 'the first attempt sent the caller\'s cap');
  assert.deepEqual(sent[0].reasoning, { enabled: false });
  assert.equal(sent[1].max_tokens, 600, 'max(600, 3 x 200) — the floor wins on a tiny cap');
  assert.deepEqual(sent[1].reasoning, { enabled: false }, 'the retry disables reasoning explicitly');
  assert.deepEqual(sent[1].messages, sent[0].messages, 'nothing else about the request changed');
  assert.equal(result.text, '{"ease":1}', 'the retry\'s reply is what the caller gets');
  assert.equal(result.truncated, false);

  assert.deepEqual(receipts(), [{
    role: 'classify', model: sent[0].model, cap: 200, retriedCap: 600, ok: true,
  }]);
});

test('the retried cap is 3x on a cap the 600 floor does not cover', async () => {
  // updateDossier's 900 and fidelity L2's 100 are the other live per-call caps.
  const { send, sent } = sender([starved(), reply()]);
  await callOpenAICompatible(req({ maxTokens: 900 }), 'openrouter', send);
  assert.equal(sent[1].max_tokens, 2700, '3 x 900');
  assert.deepEqual(receipts()[0], { role: 'classify', model: sent[0].model, cap: 900, retriedCap: 2700, ok: true });
});

test('a normal reply neither retries nor leaves a receipt', async () => {
  const { send, sent } = sender([reply()]);
  const result = await callOpenAICompatible(req(), 'openrouter', send);
  assert.equal(sent.length, 1);
  assert.equal(result.text, 'pong');
  assert.deepEqual(receipts(), [], 'the receipt fires on starvation only — not once per LLM call');
});

test('a truncated reply WITH content is not starvation — no retry', async () => {
  const { send, sent } = sender([reply({ content: 'half a sen', finish: 'length' })]);
  const result = await callOpenAICompatible(req(), 'openrouter', send);
  assert.equal(sent.length, 1);
  assert.equal(result.truncated, true, 'ordinary truncation, still reported as such');
  assert.deepEqual(receipts(), []);
});

test('LLM_STARVED_RETRY=off is today\'s behavior: one call, the starvation error, no receipt', async () => {
  process.env.LLM_STARVED_RETRY = 'off';
  const { send, sent } = sender([starved()]);
  await assert.rejects(
    () => callOpenAICompatible(req(), 'openrouter', send),
    (err: unknown) => {
      assert.equal(isStarvedError(err), true, 'the marked, statusless error the cross-lane salvage reads');
      assert.match((err as Error).message, /max_tokens=200/);
      return true;
    },
  );
  assert.equal(sent.length, 1, 'no retry at all');
  assert.deepEqual(receipts(), []);
});

test('a retry that starves AGAIN leaves an ok:false receipt and still throws, so the lane salvage runs', async () => {
  const { send, sent } = sender([starved(), starved()]);
  await assert.rejects(
    () => callOpenAICompatible(req(), 'openrouter', send),
    (err: unknown) => {
      assert.equal(isStarvedError(err), true);
      assert.match((err as Error).message, /max_tokens=600/, 'the message names the budget that actually failed last');
      return true;
    },
  );
  assert.equal(sent.length, 2, 'once — never a loop');
  assert.deepEqual(receipts(), [{ role: 'classify', model: sent[0].model, cap: 200, retriedCap: 600, ok: false }]);
});

test('a retry that ERRORS surfaces the original starvation error (the cross-lane salvage, unchanged)', async () => {
  // A 3x cap can exceed what a provider accepts. Swallowing that into the starvation error keeps the
  // statusless-and-salvageable shape callLLM's fallback depends on; the receipt keeps the cause.
  const boom = new Error('400 max_tokens exceeds the model limit');
  const { send, sent } = sender([starved(), boom]);
  await assert.rejects(
    () => callOpenAICompatible(req(), 'openrouter', send),
    (err: unknown) => {
      assert.equal(isStarvedError(err), true);
      assert.match((err as Error).message, /max_tokens=200/, 'the original cap — the retry never landed');
      return true;
    },
  );
  assert.equal(sent.length, 2);
  const r = receipts()[0];
  assert.equal(r.ok, false);
  assert.match(String(r.error), /exceeds the model limit/);
});

test('the openai lane retries too, and carries no reasoning field in either attempt', async () => {
  // engineDiscovery can put the engine's reasoning model on the generic openai lane as well; the
  // budget half of the fix works there, and `reasoning` is OpenRouter-only so it is never sent.
  const { send, sent } = sender([starved(), reply()]);
  await callOpenAICompatible(req(), 'openai', send);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].max_tokens, 600);
  for (const p of sent) assert.equal('reasoning' in p, false);
});

// ── The bug this task exists for, end to end ─────────────────────────────────

test('updateRelationshipClimate applies drift once the starved retry succeeds', async () => {
  resetStorageForTests();
  __resetClimateInFlightForTests();
  __resetClimateBackoffForTests();
  const H = '+15551230001';
  const T0 = Date.UTC(2026, 3, 1);
  const recent: StoredMessage[] = [];
  for (let i = 0; i < 4; i++) {
    recent.push({ role: 'user', content: `their line ${i}`, handle: H, at: T0 + i });
    recent.push({ role: 'assistant', content: `her reply ${i}`, at: T0 + i });
  }

  // The live shape: the first 200-token call comes back reasoning-only, the retry answers.
  const { send, sent } = sender([
    starved(),
    reply({ content: '{"ease":1,"candor":0,"playfulness":0,"reason":"it flowed"}' }),
  ]);
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const run = (_p: LlmProvider, r: LlmRequest) => callOpenAICompatible(r, 'openrouter', send);
    const llm = ((r: LlmRequest) => callLLM(r, run)) as typeof callLLM;
    await updateRelationshipClimate(H, recent, { llm, now: T0 });
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }

  assert.equal(sent.length, 2, 'the eval starved once and retried once');
  assert.equal(sent[0].max_tokens, 200, 'CLIMATE_MAX_TOKENS');
  assert.equal(sent[1].max_tokens, 600);
  const climate = await getRelationshipClimate(H);
  assert.equal(climate.dials.ease, 36, '+1, the ease up step — the drift that never applied in production');
  assert.equal(climate.lastEvalAt, T0, 'and the eval is stamped, so the cooldown holds');
});
