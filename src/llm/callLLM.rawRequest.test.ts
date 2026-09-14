// The RAW SENT PROMPT: the serialized wire request body handed to the provider,
// captured for the /dashboard and /debug diagnostics symmetrically with `raw` (the
// wire RESPONSE). "messages (sent)" on the dashboard is Irises' INTERNAL req.messages;
// this is the actual body — model, system, tools, params and all — the provider saw.
//
// No network, no key: the SDK call is injected (the `send` seam on callOpenAICompatible),
// so this exercises the REAL request shaping and the REAL capture point.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAICompatible, callLLM, type ChatSender } from './callLLM.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import type { LlmRequest, LlmProvider } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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

/** A sender that hands out `replies` in order and records every body it was sent. */
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

const TOUCHED_ENV = ['LLM_STARVED_RETRY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;
let savedEnv: Partial<Record<(typeof TOUCHED_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENV.map(k => [k, process.env[k]]));
  process.env.LLM_STARVED_RETRY = 'on';
  clearTraces();
});
afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('result.rawRequest is exactly the wire body handed to the provider', async () => {
  const { send, sent } = sender([reply()]);
  const result = await callOpenAICompatible(req(), 'openrouter', send);
  assert.equal(sent.length, 1);
  assert.deepEqual(result.rawRequest, sent[0], 'the RAW sent prompt is the served body, verbatim');
});

test('after a starved retry, rawRequest is the leg that actually answered (matching result.raw)', async () => {
  // result.raw is the retry's response; result.rawRequest must be the retry's REQUEST, not the
  // starved first leg — otherwise the dashboard shows a request/response pair that never happened.
  const { send, sent } = sender([starved(), reply()]);
  const result = await callOpenAICompatible(req(), 'openrouter', send);
  assert.equal(sent.length, 2);
  assert.deepEqual(result.rawRequest, sent[1], 'the served (retry) body');
  assert.equal((sent[1] as Any).max_tokens, 600, 'sanity: the retry leg is the 600-cap one');
});

test('the llm trace event carries the raw wire request, matching what was sent', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const { send, sent } = sender([reply()]);
  const run = (_p: LlmProvider, r: LlmRequest) => callOpenAICompatible(r, 'openrouter', send);
  await callLLM(req(), run);
  const ev = getTraces().find(e => e.type === 'llm');
  assert.ok(ev, 'an llm trace event was recorded');
  assert.deepEqual(ev.rawRequest, sent[0], 'the trace event carries the served wire body');
});
