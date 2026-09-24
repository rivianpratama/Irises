// The streamed convo call on the OpenAI-compatible lanes (LlmRequest.onTextDelta). The point of
// streaming is that her first bubble can leave before the whole envelope is generated, so the
// contract under test is narrow: the deltas reach the sink in order, the RESULT is the same shape a
// non-streamed call returns (text, usage, raw), and once anything has been emitted a failure hands
// back what already went out instead of re-running the turn on another lane.
//
// No network, no key: both SDK seams on callOpenAICompatible are injected, and callLLM's `run` seam
// routes through the real lane code, so request shaping, usage accounting and the fallback policy
// are all the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM, callOpenAICompatible, type ChatSender, type StreamSender } from './callLLM.js';
import { clearTraces, getTraces } from '../diagnostics/trace.js';
import { _test as errlog } from '../diagnostics/errorLog.js';
import type { LlmProvider, LlmRequest, LlmResult } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'LLM_CALL_TIMEOUT_MS'] as const;
let saved: Record<string, string | undefined> = {};

test.beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';   // a configured fallback lane, so "not attempted" means something
  clearTraces();
  errlog.reset();
  errlog.setFlushFn(async () => true);
});

test.afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  errlog.reset();
});

function chunk(delta: Any, over: Any = {}): Any {
  return {
    id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'fake/flash', provider: 'FakeInfra',
    choices: [{ index: 0, delta, finish_reason: over.finish ?? null }],
  };
}
const usageChunk = (): Any => ({
  id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'fake/flash', provider: 'FakeInfra',
  choices: [],
  usage: {
    prompt_tokens: 100, completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 60 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
});

/** A streaming sender that yields `items` in order (an Error entry is thrown mid-stream). */
function streamer(items: Any[]): { stream: StreamSender; sent: Any[] } {
  const sent: Any[] = [];
  const stream = ((params: Any) => {
    sent.push(params);
    return (async function* () {
      for (const it of items) {
        if (it instanceof Error) throw it;
        yield it;
      }
    })();
  }) as unknown as StreamSender;
  return { stream, sent };
}

const NO_PLAIN_SEND: ChatSender = async () => { throw new Error('the non-streamed sender must not be used'); };

function convoReq(deltas: string[], over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    role: 'convo', jsonBubbles: true, toolsViaJson: true, tools: [],
    messages: [{ role: 'user', content: 'yo' }],
    onTextDelta: d => { deltas.push(d); },
    ...over,
  };
}

test('a streamed call delivers the deltas in order and returns the same result shape', async () => {
  const deltas: string[] = [];
  const { stream, sent } = streamer([
    chunk({ role: 'assistant', content: '' }),
    chunk({ reasoning: 'thinking about it' }),          // never forwarded, never part of text
    chunk({ content: '{"bubbles":' }),
    chunk({ reasoning_content: 'more thinking' }),
    chunk({ content: '["hey"' }),
    chunk({ content: ']}' }, { finish: 'stop' }),
    usageChunk(),
  ]);
  const result = await callOpenAICompatible(convoReq(deltas), 'openrouter', NO_PLAIN_SEND, stream);

  assert.deepEqual(deltas, ['{"bubbles":', '["hey"', ']}'], 'content deltas only, in order');
  assert.equal(result.text, '{"bubbles":["hey"]}');
  assert.equal(result.emitted, true);
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.usage, {
    inputTokens: 40, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 60,
  }, 'usage from the final chunk, through the same builder (cache reads split out)');

  // The synthesized raw keeps what traces and the latency benchmark read.
  const raw = result.raw as Any;
  assert.equal(raw.provider, 'FakeInfra');
  assert.equal(raw.usage.prompt_tokens_details.cached_tokens, 60);
  assert.equal(raw.usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(raw.choices[0].message.content, '{"bubbles":["hey"]}');
  assert.equal(raw.choices[0].finish_reason, 'stop');

  // The streamed body: stream + include_usage, schema kept, the non-streaming-only plugin dropped.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stream, true);
  assert.deepEqual(sent[0].stream_options, { include_usage: true });
  assert.equal(sent[0].response_format?.type, 'json_schema');
  assert.ok(!(sent[0].plugins ?? []).some((p: Any) => p.id === 'response-healing'));
  assert.equal((result.rawRequest as Any).stream, true, 'rawRequest is the body actually sent');
});

test('a stream that breaks after emitting returns the partial text and never falls back', async () => {
  const deltas: string[] = [];
  const { stream } = streamer([chunk({ content: '{"bubbles":["he' }), new Error('socket hang up')]);
  const lanes: LlmProvider[] = [];
  const result = await callLLM(convoReq(deltas, { providerOverride: 'openrouter' }), async (provider, r) => {
    lanes.push(provider);
    if (provider !== 'openrouter') throw new Error('the fallback lane must not run');
    return callOpenAICompatible(r, provider, NO_PLAIN_SEND, stream);
  });

  assert.deepEqual(lanes, ['openrouter'], 'no cross-lane re-run of a reply already on its way out');
  assert.deepEqual(deltas, ['{"bubbles":["he']);
  assert.equal(result.text, '{"bubbles":["he');
  assert.equal(result.emitted, true);
  assert.equal(result.stopReason, 'error');
  assert.equal(getTraces().filter(e => e.label === 'llm:fallback').length, 0);
});

test('a timeout after emitting returns what already went out instead of rejecting', async () => {
  process.env.LLM_CALL_TIMEOUT_MS = '40';
  const deltas: string[] = [];
  const lanes: LlmProvider[] = [];
  const result = await callLLM(convoReq(deltas, { providerOverride: 'openrouter' }), (provider, r) => {
    lanes.push(provider);
    r.onTextDelta?.('{"bubbles":["hey');
    return new Promise<LlmResult>(() => { /* the lane never finishes */ });
  });
  assert.deepEqual(lanes, ['openrouter']);
  assert.equal(result.text, '{"bubbles":["hey');
  assert.equal(result.emitted, true);
  assert.equal(result.stopReason, 'error');
  assert.equal(getTraces().filter(e => e.label === 'llm:timeout').length, 1, 'the give-up is still on the record');
});
