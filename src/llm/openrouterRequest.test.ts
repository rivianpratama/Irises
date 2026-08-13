import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenRouterParams, toOpenRouterContent, hasDocument, hasNativeMedia, isLengthStarved } from './openrouterRequest.js';
import { MODELS, MAX_TOKENS } from './models.js';
import type { LlmRequest } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test('PDF/document block becomes an OpenRouter file part with a base64 data URL (not dropped)', () => {
  const parts = toOpenRouterContent([{ type: 'document', mediaType: 'application/pdf', data: 'QUJD' }]) as Any[];
  assert.equal(parts[0].type, 'file');
  assert.equal(parts[0].file.file_data, 'data:application/pdf;base64,QUJD');
  assert.equal(parts[0].file.filename, 'document.pdf');
});

test('image block maps to an image_url part', () => {
  const parts = toOpenRouterContent([{ type: 'image', url: 'https://x/y.png' }]) as Any[];
  assert.equal(parts[0].type, 'image_url');
  assert.equal(parts[0].image_url.url, 'https://x/y.png');
});

test('an inlined audio block maps to an input_audio part (base64 data + format)', () => {
  const parts = toOpenRouterContent([{ type: 'audio', mimeType: 'audio/mp4', data: 'QUJD', format: 'm4a' }]) as Any[];
  assert.equal(parts[0].type, 'input_audio');
  assert.equal(parts[0].input_audio.data, 'QUJD');
  assert.equal(parts[0].input_audio.format, 'm4a');
});

test('an inlined video block maps to a video_url part with a base64 data URL', () => {
  const parts = toOpenRouterContent([{ type: 'video', mimeType: 'video/mp4', data: 'VklE' }]) as Any[];
  assert.equal(parts[0].type, 'video_url');
  assert.equal(parts[0].video_url.url, 'data:video/mp4;base64,VklE');
});

test('an un-inlined audio/video block (no data) is dropped rather than emitting a partial part', () => {
  const parts = toOpenRouterContent([
    { type: 'audio', mimeType: 'audio/mp4' },
    { type: 'video', mimeType: 'video/mp4' },
    { type: 'text', text: 'still here' },
  ]) as Any[];
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
});

test('hasNativeMedia is true for audio/video, false for image/text/document', () => {
  const mk = (block: Any): LlmRequest => ({ role: 'ops', messages: [{ role: 'user', content: [block] }] });
  assert.equal(hasNativeMedia(mk({ type: 'audio', mimeType: 'audio/mp4', data: 'x' })), true);
  assert.equal(hasNativeMedia(mk({ type: 'video', mimeType: 'video/mp4', data: 'x' })), true);
  assert.equal(hasNativeMedia(mk({ type: 'image', url: 'u' })), false);
  assert.equal(hasNativeMedia(mk({ type: 'document', mediaType: 'application/pdf', data: 'x' })), false);
  assert.equal(hasNativeMedia({ role: 'ops', messages: [{ role: 'user', content: 'plain' }] }), false);
});

test('a plain string content is passed through untouched', () => {
  assert.equal(toOpenRouterContent('hello'), 'hello');
});

test('enableWebSearch adds the openrouter:web_search server tool alongside function tools', () => {
  const req: LlmRequest = {
    role: 'ops',
    messages: [{ role: 'user', content: 'research this' }],
    tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
    enableWebSearch: true,
  };
  const types = (buildOpenRouterParams(req).tools ?? []).map((t: Any) => t.type);
  assert.ok(types.includes('function'), 'keeps the function tool');
  assert.ok(types.includes('openrouter:web_search'), 'adds the server-side web_search tool');
});

test('web_search tool is omitted when enableWebSearch is not set', () => {
  const req: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'hi' }] };
  const tools = buildOpenRouterParams(req).tools ?? [];
  assert.ok(!tools.some((t: Any) => t.type === 'openrouter:web_search'));
});

test('web_search is CAPPED on the wire: parameters.max_uses + request-level max_tool_calls', () => {
  // Uncapped server-side search is billed as prompt tokens — the regression this guards.
  const req: LlmRequest = {
    role: 'ops',
    messages: [{ role: 'user', content: 'research this' }],
    enableWebSearch: true,
    webSearchMaxUses: 2,
  };
  const params = buildOpenRouterParams(req);
  const ws = (params.tools ?? []).find((t: Any) => t.type === 'openrouter:web_search') as Any;
  assert.equal(ws.parameters.max_uses, 2);
  assert.equal(params.max_tool_calls, 2);
});

test('web_search cap defaults to 3 when webSearchMaxUses is unset', () => {
  const req: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'x' }], enableWebSearch: true };
  const params = buildOpenRouterParams(req);
  const ws = (params.tools ?? []).find((t: Any) => t.type === 'openrouter:web_search') as Any;
  assert.equal(ws.parameters.max_uses, 3);
  assert.equal(params.max_tool_calls, 3);
});

test('web search off still carries the always-on server-tool ceiling (default 8)', () => {
  // Even with no web_search tool, a deep-research model browses server-side; the default ceiling
  // bounds it (OpenRouter's own default is 30). See OPENROUTER_MAX_TOOL_CALLS_DEFAULT.
  const req: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'x' }] };
  assert.equal(buildOpenRouterParams(req).max_tool_calls, 8);
});

test('file-parser plugin attaches only when a PDF is present', () => {
  const withDoc: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: 'QQ' }] }] };
  const noDoc: LlmRequest = { role: 'ops', messages: [{ role: 'user', content: 'plain text' }] };

  assert.equal(hasDocument(withDoc), true);
  assert.equal(hasDocument(noDoc), false);

  const plugins = buildOpenRouterParams(withDoc).plugins as Any[];
  assert.equal(plugins[0].id, 'file-parser');
  assert.equal(plugins[0].pdf.engine, 'cloudflare-ai'); // free default
  assert.equal(buildOpenRouterParams(noDoc).plugins, undefined);
});

test('system prompt becomes a leading system message', () => {
  // classify opts into no caching, so its system stays a bare string — keeps this a placement check,
  // not a caching one (convo now sends a cache_control block; see the convo caching test below).
  const req: LlmRequest = { role: 'classify', system: 'you are irises', messages: [{ role: 'user', content: 'hi' }] };
  const msgs = buildOpenRouterParams(req).messages as Any[];
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'you are irises');
  assert.equal(msgs[1].role, 'user');
});

test('model + max_tokens default from the role tables; modelOverride wins', () => {
  const base = buildOpenRouterParams({ role: 'fallfirm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(typeof base.model, 'string');
  assert.ok((base.max_tokens ?? 0) > 0);

  const overridden = buildOpenRouterParams({ role: 'fallfirm', modelOverride: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(overridden.model, 'openai/gpt-4o');
});

test('fallfirm role resolves to its OpenRouter model + max_tokens from the role tables', () => {
  const params = buildOpenRouterParams({ role: 'fallfirm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(params.model, MODELS.fallfirm.openrouter);
  assert.equal(params.max_tokens, MAX_TOKENS.fallfirm);
  assert.equal(MAX_TOKENS.fallfirm, 8192); // high non-binding ceiling — reasoning tokens count against max_tokens on OpenRouter
});

test('jsonBubbles adds a strict json_schema response_format + require_parameters routing', () => {
  const params = buildOpenRouterParams({ role: 'convo', jsonBubbles: true, tools: [{ name: 'delegate_to_ops', description: 'x', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: 'x' }] });
  const rf = params.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema.name, 'irises_reply');
  assert.equal(rf.json_schema.strict, true);
  assert.deepEqual(rf.json_schema.schema.required, ['confidence_level', 'bubbles']);
  assert.equal((params.provider as { require_parameters?: boolean }).require_parameters, true);
  // without toolsViaJson the tools still ride natively (the judge-style shape)
  assert.ok(Array.isArray(params.tools) && params.tools.length === 1);
});

// ── toolsViaJson: the written-tool-call protocol ─────────────────────────────────────────────────

const CONVO_LIKE_TOOLS = [
  {
    name: 'delegate_to_ops',
    description: 'hand work to ops',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dealmachine', 'general'], description: 'which lane' },
        request: { type: 'string' },
        meta_prompt: { type: 'string' },
      },
      required: ['kind', 'request'],
    },
  },
  {
    name: 'unlink_account',
    description: 'unlink an account',
    inputSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] },
  },
];

test('toolsViaJson omits the native tools param and swaps in the extended envelope schema', () => {
  const params = buildOpenRouterParams({
    role: 'convo', jsonBubbles: true, toolsViaJson: true,
    tools: CONVO_LIKE_TOOLS, messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(params.tools, undefined, 'native tools must NOT be sent');
  const rf = params.response_format as Any;
  assert.equal(rf.json_schema.strict, true);
  const schema = rf.json_schema.schema as Any;
  // truncation-safe field order: confidence first, tool_calls BEFORE bubbles
  assert.deepEqual(schema.required, ['confidence_level', 'tool_calls', 'bubbles']);
  assert.deepEqual(Object.keys(schema.properties), ['confidence_level', 'tool_calls', 'bubbles']);
  // name is a hard enum of exactly the offered tools
  const items = schema.properties.tool_calls.items;
  assert.deepEqual(items.properties.name.enum, ['delegate_to_ops', 'unlink_account']);
  // args is the flat union: every arg from every tool, nullable, strict-required
  const args = items.properties.args;
  assert.equal(args.additionalProperties, false);
  assert.deepEqual(args.required.sort(), ['confirmed', 'kind', 'meta_prompt', 'request']);
  assert.deepEqual(args.properties.confirmed.type, ['boolean', 'null']);
  assert.deepEqual(args.properties.kind.type, ['string', 'null']); // enum flattened into the description
  assert.ok(String(args.properties.kind.description).includes('dealmachine'));
  assert.equal((params.provider as Any).require_parameters, true);
});

test('toolsViaJson attaches the response-healing plugin, merged with file-parser when a PDF rides along', () => {
  const base: LlmRequest = {
    role: 'convo', jsonBubbles: true, toolsViaJson: true, tools: CONVO_LIKE_TOOLS,
    messages: [{ role: 'user', content: 'x' }],
  };
  const plugins = buildOpenRouterParams(base).plugins as Any[];
  assert.deepEqual(plugins.map(p => p.id), ['response-healing']);

  const withDoc: LlmRequest = {
    ...base,
    messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: 'QQ' }] }],
  };
  const merged = buildOpenRouterParams(withDoc).plugins as Any[];
  assert.deepEqual(merged.map(p => p.id), ['response-healing', 'file-parser']);
});

test('tool-less jsonBubbles callers (composer/autonome/fallfirm shape) are byte-identical to before', () => {
  const params = buildOpenRouterParams({ role: 'fallfirm', jsonBubbles: true, messages: [{ role: 'user', content: 'x' }] });
  const schema = (params.response_format as Any).json_schema.schema;
  assert.deepEqual(schema.required, ['confidence_level', 'bubbles']);
  assert.equal(params.tools, undefined);
  assert.equal(params.plugins, undefined);
});

test('without jsonBubbles there is no response_format (plain call unaffected)', () => {
  const params = buildOpenRouterParams({ role: 'convo', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(params.response_format, undefined);
  assert.equal(params.provider, undefined);
});

// ── Ops tuning on the OpenRouter path (assumes default env: thinking on, effort xhigh, cache on) ──

test('ops system prompt is sent as a cache_control content block (prompt caching)', () => {
  const req: LlmRequest = { role: 'ops', system: 'ops ctx', messages: [{ role: 'user', content: 'hi' }] };
  const msgs = buildOpenRouterParams(req).messages as Any[];
  assert.equal(msgs[0].role, 'system');
  assert.ok(Array.isArray(msgs[0].content), 'system content is a block array, not a bare string');
  assert.equal(msgs[0].content[0].type, 'text');
  assert.equal(msgs[0].content[0].text, 'ops ctx');
  assert.equal(msgs[0].content[0].cache_control.type, 'ephemeral');
});

test('ops params carry reasoning; effort is capped to OpenRouter high (xhigh default maps down)', () => {
  const params = buildOpenRouterParams({ role: 'ops', messages: [{ role: 'user', content: 'x' }] }) as Any;
  assert.ok(params.reasoning, 'reasoning is set for the ops role');
  assert.equal(params.reasoning.enabled, true);
  assert.equal(params.reasoning.effort, 'high');
});

test('ops max_tokens defaults from the role table (env-overridable via OPS_MAX_TOKENS)', () => {
  const params = buildOpenRouterParams({ role: 'ops', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(params.max_tokens, MAX_TOKENS.ops);
});

test('temperature passes through on the OpenRouter path when set', () => {
  const params = buildOpenRouterParams({ role: 'ops', temperature: 0.4, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(params.temperature, 0.4);
});

test('non-opted-in roles carry no reasoning and keep a plain-string system', () => {
  // fallfirm opts into neither reasoning nor caching (both hardcoded off, not env-driven) — a stable
  // example of the plain-string path. (convo used to sit here but now opts into caching; see below.)
  const params = buildOpenRouterParams({ role: 'fallfirm', system: 'sys', messages: [{ role: 'user', content: 'x' }] }) as Any;
  assert.equal(params.reasoning, undefined);
  assert.equal(params.messages[0].content, 'sys');
});

test('convo system prompt is sent as a cache_control content block (persona caching, CONVO_CACHE_SYSTEM default on)', () => {
  // Convo caches its large persona so the Anthropic fallback lane bills it at ~10% on cache hits.
  // On this OpenRouter lane the marker is a harmless passthrough non-Anthropic providers ignore.
  const params = buildOpenRouterParams({ role: 'convo', system: 'persona', messages: [{ role: 'user', content: 'x' }] }) as Any;
  assert.ok(Array.isArray(params.messages[0].content), 'convo system is now a cache_control block array');
  assert.equal(params.messages[0].content[0].text, 'persona');
  assert.equal(params.messages[0].content[0].cache_control.type, 'ephemeral');
});

test('isLengthStarved: length finish with no content and no tool calls is starvation', () => {
  assert.equal(isLengthStarved({ finish_reason: 'length', message: { content: null, tool_calls: undefined } }), true);
  assert.equal(isLengthStarved({ finish_reason: 'length', message: { content: '', tool_calls: [] } }), true);
});

test('isLengthStarved: length finish with partial content is ordinary truncation, not starvation', () => {
  assert.equal(isLengthStarved({ finish_reason: 'length', message: { content: 'ANSWER: partial…', tool_calls: [] } }), false);
});

test('isLengthStarved: a tool-call-only reply cut at the limit is still usable', () => {
  assert.equal(isLengthStarved({ finish_reason: 'length', message: { content: null, tool_calls: [{ id: 't1' }] } }), false);
});

test('isLengthStarved: non-length finishes are never starvation, even with empty content', () => {
  assert.equal(isLengthStarved({ finish_reason: 'stop', message: { content: null, tool_calls: [] } }), false);
  assert.equal(isLengthStarved({ finish_reason: null, message: { content: null } }), false);
});
