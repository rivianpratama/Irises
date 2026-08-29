// The lane split: buildOpenAIParams (generic OpenAI-compatible body) must NOT carry any
// OpenRouter-proprietary field, while buildOpenRouterParams still does. Same request, two builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIParams, buildOpenRouterParams } from './openrouterRequest.js';
import type { LlmRequest } from './types.js';

function convoReq(): LlmRequest {
  return {
    role: 'convo',
    system: 'PERSONA',
    messages: [{ role: 'user', content: 'hi' }],
    jsonBubbles: true,
    toolsViaJson: true,
    enableWebSearch: true,
    webSearchMaxUses: 2,
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  };
}

test('buildOpenAIParams omits every OpenRouter-proprietary field', () => {
  const p = buildOpenAIParams(convoReq()) as Record<string, unknown>;
  // Generic OpenAI fields ARE present.
  assert.ok(p.response_format, 'response_format (structured outputs) is generic and kept');
  assert.equal(typeof p.model, 'string');
  // OpenRouter-only fields are ABSENT.
  assert.equal('provider' in p, false, 'no provider routing prefs');
  assert.equal('plugins' in p, false, 'no plugins (file-parser / response-healing)');
  assert.equal('reasoning' in p, false, 'no unified reasoning field');
  assert.equal('max_tool_calls' in p, false, 'no max_tool_calls');
  // The system message is a PLAIN string (no cache_control passthrough) on the generic lane.
  const sys = (p.messages as Array<{ role: string; content: unknown }>)[0];
  assert.equal(sys.role, 'system');
  assert.equal(typeof sys.content, 'string');
  // The openrouter:web_search server tool is NOT attached on the generic lane.
  assert.equal(p.tools, undefined);
});

test('buildOpenRouterParams still carries the OpenRouter-proprietary fields', () => {
  const p = buildOpenRouterParams(convoReq()) as Record<string, unknown>;
  assert.ok(p.response_format);
  assert.ok(p.provider, 'require_parameters routing present');
  assert.equal(typeof p.max_tool_calls, 'number', 'server-tool ceiling present');
  assert.ok(Array.isArray(p.plugins) || p.plugins === undefined ? true : false);
  // cache_control system passthrough (CACHE_SYSTEM.convo defaults on) → system is a block array.
  const sys = (p.messages as Array<{ role: string; content: unknown }>)[0];
  assert.ok(Array.isArray(sys.content), 'openrouter system carries the cache_control block form');
  // web_search server tool attached.
  assert.ok(Array.isArray(p.tools) && (p.tools as Array<{ type?: string }>).some(t => t.type === 'openrouter:web_search'));
});

test('the two builders resolve their own lane model slug', () => {
  const oa = buildOpenAIParams(convoReq());
  const or = buildOpenRouterParams(convoReq());
  // openai lane defaults to the bare OpenAI id; openrouter to the aggregator slug.
  assert.equal(oa.model, process.env.CONVO_MODEL_OPENAI || 'gpt-5.6-luna');
  assert.equal(or.model, process.env.CONVO_MODEL_OPENROUTER || 'deepseek/deepseek-v4-flash');
});
