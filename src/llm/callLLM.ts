import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODELS, MAX_TOKENS, PROVIDERS, THINKING, EFFORT, CACHE_SYSTEM, TEMPERATURE } from './models.js';
import { BUBBLE_ENVELOPE_SCHEMA, buildEnvelopeSchema, parseReply } from '../pipeline/bubbleJson.js';
import { buildOpenRouterParams, buildOpenAIParams, hasDocument, hasNativeMedia, isLengthStarved, starvedRetryEnabled, type OpenRouterParams } from './openrouterRequest.js';
import { renderTimestamps } from './timedMessages.js';
import { inlineImageBlocks } from './inlineImages.js';
import { inlineMediaBlocks } from './inlineMedia.js';
import { record } from '../diagnostics/trace.js';
import { recordTokenUsage } from '../db/repositories/tokenUsage.js';
import { fromAnthropicContent, fromOpenRouterMessage } from './serverToolText.js';
import { shouldFallback } from './fallbackPolicy.js';
import { isTruncatedStop, starvedError, isStarvedError, bumpStarvedBudget, starvedRetryCap } from './truncation.js';
import { reportError } from '../diagnostics/errorLog.js';
import { checkCallBudgets, reportTaskUsage } from './budget.js';
import { isLaneConfigured, laneEnvVar, laneKey, laneBaseUrl, laneUnconfiguredError, noLaneConfiguredError } from './laneKeys.js';
import type { LlmRequest, LlmResult, LlmContentBlock, LlmProvider } from './types.js';

// Clients are built LAZILY and rebuilt when the key changes. A lane whose key is unset or BLANK
// (`ANTHROPIC_API_KEY=` — see laneKeys.ts) must end up with NO client at all: `new Anthropic()`
// accepts a blank key and only throws from inside the first request, which is how a keyless
// fallback leg used to bury the primary lane's real error.
let anthropicLane: { key: string; client: Anthropic } | null = null;
function anthropicClient(): Anthropic | null {
  const key = laneKey('anthropic');
  if (!key) return null;
  if (anthropicLane?.key !== key.value) {
    // ANTHROPIC_AUTH_TOKEN configures the lane just as well as an api key — send whichever we have,
    // as the matching option (the SDK resolves exactly one auth header). Everything else (base URL,
    // …) keeps coming from the SDK's own env defaults.
    anthropicLane = {
      key: key.value,
      client: new Anthropic(key.envVar === 'ANTHROPIC_AUTH_TOKEN' ? { authToken: key.value } : { apiKey: key.value }),
    };
  }
  return anthropicLane.client;
}

// Both OpenAI-compatible lanes take an env-configurable base URL (laneBaseUrl, read at CALL time so a
// .env edit between runs is honoured). The lane cache keys on key AND base URL, so repointing
// OPENAI_BASE_URL (or the key) rebuilds the client rather than reusing a stale connection.
let openrouterLane: { key: string; baseURL: string; client: OpenAI } | null = null;
function openrouterClient(): OpenAI | null {
  const key = laneKey('openrouter');
  if (!key) return null;
  const baseURL = laneBaseUrl('openrouter');
  if (openrouterLane?.key !== key.value || openrouterLane?.baseURL !== baseURL) {
    openrouterLane = { key: key.value, baseURL, client: new OpenAI({ apiKey: key.value, baseURL }) };
  }
  return openrouterLane.client;
}

let openaiLane: { key: string; baseURL: string; client: OpenAI } | null = null;
function openaiClient(): OpenAI | null {
  const key = laneKey('openai');
  if (!key) return null;
  const baseURL = laneBaseUrl('openai');
  if (openaiLane?.key !== key.value || openaiLane?.baseURL !== baseURL) {
    openaiLane = { key: key.value, baseURL, client: new OpenAI({ apiKey: key.value, baseURL }) };
  }
  return openaiLane.client;
}

// --- Anthropic ------------------------------------------------------------
export function toAnthropicContent(content: string | LlmContentBlock[]): Anthropic.ContentBlockParam[] | string {
  if (typeof content === 'string') return content;
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      // A prefetched `data:<mime>;base64,…` URL (MM's verified fetch, or the ops read_attachment image
      // lane) must map to a base64 source — Anthropic's `url` source cannot read data: URLs (400).
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b.url);
      out.push(m
        ? { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg', data: m[2] } }
        : { type: 'image', source: { type: 'url', url: b.url } });
    }
    else if (b.type === 'document') out.push({ type: 'document', source: { type: 'base64', media_type: b.mediaType as 'application/pdf', data: b.data } });
    else {
      // audio | video — Anthropic has no native support. The fallback guard (hasNativeMedia) keeps
      // these off this path in practice; this is a belt-and-suspenders drop-with-note so a
      // misconfigured role degrades to text instead of throwing.
      console.warn(`[llm] ${b.type} block dropped on the Anthropic path (unsupported)`);
      out.push({ type: 'text', text: `[${b.type} attachment omitted — not supported on this model]` });
    }
  }
  return out;
}

// The web_search server tool can return stop_reason 'pause_turn' mid-turn; we must echo the
// response content back verbatim (it carries encrypted citation tokens) and continue. Bound the
// continuations so a runaway can't loop. SDK 0.39 doesn't type these wire features — hence the casts.
const MAX_PAUSE_CONTINUATIONS = 4;

/** Restore inputs SDK 0.39's stream accumulator drops: it applies input_json_delta only to
 *  'tool_use' blocks, so server-tool blocks (web_search's server_tool_use) end the stream with an
 *  empty input. Patch them from our own raw-delta buffers, keyed by content-block index. Client
 *  tool_use blocks are left to the SDK (its partial-JSON accumulation already handled them). */
export function patchServerToolInputs(content: Array<{ type: string; input?: unknown }>, inputBufs: Map<number, string>): void {
  for (const [index, buf] of inputBufs) {
    const block = content[index];
    if (!block || block.type === 'tool_use' || !buf) continue;
    try { block.input = JSON.parse(buf); } catch { /* partial JSON — leave the SDK's snapshot */ }
  }
}

/** One `cache_control`-carrying text block. The remainder block after a prefix split has no marker. */
type AnthropicSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Build the Anthropic `system` param, caching the large stable prefix for opted-in roles. Sub-
 * 1024/4096-token cached spans silently won't cache (no error). Three shapes:
 *  • caching off → the bare string (Anthropic bills it as ordinary input every call).
 *  • caching on WITH a stable-prefix boundary (Convo: static persona THEN per-turn sections) → the
 *    persona as its OWN cached block + the per-turn remainder as a second, UNcached block, so the
 *    cache matches the persona across turns. Without the split the single breakpoint sits after the
 *    per-turn-varying tail (current time to ms, dossier, …), making every turn a full cache WRITE —
 *    no reads, ~25% premium, and the write tokens still count toward the daily cap. This is the bug
 *    the split fixes; the boundary is validated (0 < len < system.length) or we fall through.
 *  • caching on with no valid boundary → the whole system as one cached block (roles whose
 *    system is stable end to end).
 * Exported for unit tests.
 */
export function buildAnthropicSystem(
  system: string | undefined,
  cacheEnabled: boolean,
  cachePrefixLen: number | undefined,
): string | AnthropicSystemBlock[] | undefined {
  if (!system) return undefined;
  if (!cacheEnabled) return system;
  if (typeof cachePrefixLen === 'number' && cachePrefixLen > 0 && cachePrefixLen < system.length) {
    return [
      { type: 'text', text: system.slice(0, cachePrefixLen), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system.slice(cachePrefixLen) },
    ];
  }
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

async function callAnthropic(req: LlmRequest): Promise<LlmResult> {
  const client = anthropicClient();
  if (!client) throw laneUnconfiguredError('anthropic');
  const model = req.modelOverride || MODELS[req.role].anthropic;
  // The cap actually sent: a per-call override BINDS over the role ceiling (the small hardcoded
  // caps), and it is what the starvation guard and the ledger must report.
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  // toolsViaJson: tools travel inside the envelope schema + prompt docs, never as the native param
  // (same either/or as the OpenRouter path — both channels at once risks double-dispatch).
  const tools: Anthropic.Tool[] = req.toolsViaJson ? [] : (req.tools ?? []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  if (req.enableWebSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: req.webSearchMaxUses ?? 3 } as unknown as Anthropic.Tool);
  }

  // Structured message timestamps become in-band content here (the API rejects unknown keys).
  const messages: Anthropic.MessageParam[] = renderTimestamps(req.messages).map(m => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }));

  // Per-role tuning (Ops opts in; see models.ts). Adaptive thinking + effort raise accuracy on the
  // multi-step tool loop; caching the stable system prefix cuts the repeated cost across steps.
  const thinking = THINKING[req.role];
  const effort = EFFORT[req.role];
  const temp = req.temperature ?? TEMPERATURE[req.role] ?? undefined;
  // temperature and extended thinking are mutually exclusive on Claude 4.x (the API 400s). When
  // thinking is on, drop temperature and warn so a misconfig is visible.
  const sendTemp = temp !== undefined && !thinking;
  if (temp !== undefined && thinking) {
    console.warn(`[llm] ${req.role}: temperature ignored — mutually exclusive with adaptive thinking on Claude 4.x (set thinking off to use it)`);
  }
  // Cache the large, stable system prefix for opted-in roles (see buildAnthropicSystem).
  const systemParam = buildAnthropicSystem(req.system, CACHE_SYSTEM[req.role], req.systemCachePrefixLen);

  // jsonBubbles: enforce the bubble envelope AT THE API on this path too, via structured outputs
  // (output_config.format, GA — coexists with tools exactly like OpenRouter's response_format).
  // This closes the fallback hole where a transient OpenRouter failure landed a jsonBubbles turn on
  // Anthropic with NO schema enforcement, letting prompt-only prose slip out to the bubble splitter.
  const buildOutputConfig = (withFormat: boolean, withEffort = true): Record<string, unknown> | undefined => {
    const cfg: Record<string, unknown> = {};
    if (withEffort && effort) cfg.effort = effort;
    if (withFormat && req.jsonBubbles) {
      cfg.format = { type: 'json_schema', schema: req.envelopeSchema ?? (req.toolsViaJson ? buildEnvelopeSchema(req.tools) : BUBBLE_ENVELOPE_SCHEMA) };
    }
    return Object.keys(cfg).length ? cfg : undefined;
  };

  // SDK 0.39 doesn't type adaptive thinking or output_config; cast the whole params bag (same
  // precedent as the web_search tool + pause_turn casts elsewhere in this file).
  // STREAMING, not create(): the SDK hard-rejects non-streaming requests whose max_tokens implies
  // >10 min of generation (throws at >21,333 tokens) — with the 64k Ops ceiling that error fires on
  // EVERY call and, being statusless, silently reroutes the whole role to the OpenRouter fallback
  // lane. finalMessage() accumulates the stream back into a complete Message — content blocks,
  // tool_use inputs, usage, stop_reason all arrive as before, EXCEPT server-tool inputs: SDK 0.39's
  // accumulator predates server tools and only rebuilds input_json_delta for blocks of type
  // 'tool_use', so a server_tool_use block (web_search) would come back with an empty input — and
  // the pause_turn echo must be verbatim. We accumulate the raw deltas ourselves and patch the
  // final message.
  const create = async (outputConfig: Record<string, unknown> | undefined = buildOutputConfig(true)) => {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokensSent,
      ...(sendTemp ? { temperature: temp } : {}),
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(tools.length ? { tools } : {}),
      messages,
      // Document requests: one retry, not the SDK default two — each retry re-uploads the full
      // base64 payload (megabytes) and re-bills the parse.
    } as unknown as Anthropic.MessageStreamParams, { signal: req.signal, ...(hasDocument(req) ? { maxRetries: 1 } : {}) });
    const inputBufs = new Map<number, string>();
    stream.on('streamEvent', (event: unknown) => {
      const e = event as { type?: string; index?: number; delta?: { type?: string; partial_json?: string } };
      if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && typeof e.index === 'number') {
        inputBufs.set(e.index, (inputBufs.get(e.index) ?? '') + (e.delta.partial_json ?? ''));
      }
    });
    const msg = await stream.finalMessage();
    patchServerToolInputs(msg.content as Array<{ type: string; input?: unknown }>, inputBufs);
    return msg;
  };

  let resp: Awaited<ReturnType<typeof create>>;
  try {
    resp = await create();
  } catch (err) {
    // Never let schema enforcement take down a chat turn: on a 400 for a jsonBubbles request
    // (e.g. a model/schema-shape rejection), retry once WITHOUT the format — the persona's own
    // JSON contract still applies, and parseReply's passthrough remains the floor beneath that.
    // The retry ALSO drops effort: a jsonBubbles role that opts into reasoning effort (Convo/MM)
    // can land its Anthropic FALLBACK on a model that rejects output_config.effort (e.g. Haiku 4.5),
    // and effort is exactly as likely as the schema to be what 400'd — dropping both lets the fallback
    // degrade to a plain reply instead of erroring the whole turn.
    // Under toolsViaJson the retry deliberately does NOT re-attach native tools: the system prompt
    // still documents the full tool_calls protocol, so a prompt-only envelope carries the turn
    // (mixing native tools back in is the one way to double-dispatch the same action).
    if (req.jsonBubbles && (err as { status?: number })?.status === 400) {
      console.warn('[llm] output_config rejected on Anthropic — retrying without schema enforcement or effort (prompt-level JSON only)');
      // The turn survives, but it survives UNENFORCED (prompt-level JSON only) — a standing
      // model/schema misconfig otherwise leaves no trail beyond this line.
      reportError({
        source: 'llm', category: 'degraded', severity: 'warn',
        message: 'output_config rejected on Anthropic — degraded to prompt-only JSON',
        detail: { model, role: req.role },
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      });
      resp = await create(buildOutputConfig(false, false));
    } else {
      throw err;
    }
  }
  const textParts: string[] = [];
  const serverTextParts: string[] = [];
  let toolCalls: LlmResult['toolCalls'] = [];
  // Accumulate usage across pause_turn continuations (web_search), each leg billed separately.
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  // Every wire response leg, verbatim — diagnostics-only (the /dashboard "raw" view).
  const rawLegs: unknown[] = [];

  for (let i = 0; ; i++) {
    rawLegs.push(resp);
    const u = resp.usage;
    if (u) {
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
      usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
    }
    const stepToolCalls: LlmResult['toolCalls'] = [];
    for (const block of resp.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        stepToolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
      // server_tool_use / web_search_tool_result blocks are resolved server-side; ignore them here.
    }
    toolCalls = stepToolCalls;
    // Harvest server-side web_search results (titles/urls/cited snippets) from this leg's content —
    // they never arrive as a client tool_use, so Ops can only ground web-sourced facts if we surface
    // them (see serverToolText.ts). Accumulated across pause_turn legs.
    const legWeb = fromAnthropicContent(resp.content);
    if (legWeb) serverTextParts.push(legWeb);

    // Continue the same turn while the server tool (web_search) pauses, bounded.
    if ((resp.stop_reason as string) === 'pause_turn' && i < MAX_PAUSE_CONTINUATIONS) {
      messages.push({ role: 'assistant', content: resp.content as unknown as Anthropic.MessageParam['content'] });
      resp = await create();
      continue;
    }
    break;
  }

  const text = textParts.length ? textParts.join('\n') : null;
  // Reasoning starvation, the Anthropic twin of the OpenRouter guard below (isLengthStarved):
  // adaptive thinking / output_config.effort spend against max_tokens, so the whole budget can go
  // to reasoning and the reply arrive with stop_reason 'max_tokens' and NOTHING in it. Returned as
  // a normal result it reads as an "empty reply" and callers retry with identical params (starving
  // identically). Throw instead — statusless, so shouldFallback salvages the turn on the other
  // lane, and callLLM retries there with a BIGGER budget (bumpStarvedBudget).
  if (isTruncatedStop(resp.stop_reason) && !text?.trim() && !toolCalls.length) {
    throw starvedError('anthropic', model, maxTokensSent);
  }

  return {
    text,
    toolCalls,
    stopReason: resp.stop_reason ?? null,
    truncated: isTruncatedStop(resp.stop_reason),
    provider: 'anthropic',
    model,
    usage,
    serverToolText: serverTextParts.length ? serverTextParts.join('\n') : undefined,
    raw: rawLegs.length === 1 ? rawLegs[0] : rawLegs,
  };
}

// --- OpenAI-compatible lanes (openrouter + openai) ------------------------
// Request shaping lives in the pure, unit-tested ./openrouterRequest module: buildOpenRouterParams
// (openrouter.ai + proprietary extras) vs buildOpenAIParams (generic body, any OpenAI-compatible
// base URL). Here we only make the call + parse the reply. Both lanes are the same OpenAI SDK.

/** The one SDK method these lanes use. Injectable into callOpenAICompatible ONLY so the starvation
 *  policy (does it retry, with which cap, with reasoning off) is unit-testable against a fake
 *  provider — no key, no network. Production callers pass nothing. */
export type ChatSender = (
  params: OpenRouterParams,
  opts: { signal?: AbortSignal; maxRetries?: number },
) => Promise<OpenAI.Chat.Completions.ChatCompletion>;

export async function callOpenAICompatible(
  req: LlmRequest,
  provider: 'openrouter' | 'openai',
  sendOverride?: ChatSender,
): Promise<LlmResult> {
  let send = sendOverride;
  if (!send) {
    const client = provider === 'openrouter' ? openrouterClient() : openaiClient();
    if (!client) throw laneUnconfiguredError(provider);
    send = (p, o) => client.chat.completions.create(p, o);
  }
  // Inline remote media as base64 first — providers (esp. Google/Gemini) can't reliably fetch remote
  // image/audio/video URLs, and messaging-CDN links are often not publicly retrievable. Each inliner
  // only touches its own block types, so the order is irrelevant.
  const prepared = await inlineMediaBlocks(await inlineImageBlocks(req));
  /** This request's body. `maxTokens`/`disableReasoning` are the starved retry's two changes; the
   *  rest of the body is rebuilt identically, so nothing else about the call drifts between legs. */
  const build = (opts?: { maxTokens?: number; disableReasoning?: boolean }): OpenRouterParams => {
    const r = opts?.maxTokens !== undefined ? { ...prepared, maxTokens: opts.maxTokens } : prepared;
    return provider === 'openrouter'
      ? buildOpenRouterParams(r, { disableReasoning: opts?.disableReasoning })
      : buildOpenAIParams(r) as OpenRouterParams;   // the generic lane never carries `reasoning`
  };
  let params = build();
  const model = params.model;

  // signal: cancel the in-flight HTTP request, not just the loop around it (see LlmRequest.signal).
  // Document requests get one retry, not the default two — a retry re-uploads the full base64 body.
  const sendOpts = { signal: req.signal, ...(hasDocument(req) ? { maxRetries: 1 } : {}) };
  let resp = await send(params, sendOpts);
  let choice = resp.choices[0];

  // Reasoning starvation: the whole max_tokens budget went to chain-of-thought and the reply carries
  // no content/tool call at all. An identical retry starves identically, so it gets ONE same-lane
  // retry with a real budget (starvedRetryCap: 3x, floored at 600) and reasoning switched off — the
  // two things that were wrong. This is the live classify-lane failure: a 200-token climate eval on
  // an inherited deepseek-v4 spent the whole cap thinking, so the relationship climate never moved.
  // Cheaper and more faithful than the cross-lane salvage below it: same model, same prompt, just
  // room to answer. Flag LLM_STARVED_RETRY; off → straight to the throw, as before.
  if (isLengthStarved(choice) && starvedRetryEnabled()) {
    const cap = params.max_tokens ?? MAX_TOKENS[req.role];
    const retriedCap = starvedRetryCap(cap);
    let ok = false;
    let error: string | undefined;
    let retryErr: unknown;
    let starvedCap = cap;
    try {
      const retryParams = build({ maxTokens: retriedCap, disableReasoning: true });
      const retryResp = await send(retryParams, sendOpts);
      const retryChoice = retryResp.choices[0];
      ok = !isLengthStarved(retryChoice);
      if (ok) { resp = retryResp; choice = retryChoice; params = retryParams; }
      else starvedCap = retriedCap;   // the budget that actually failed last
    } catch (err) {
      // A 3x cap can exceed what a provider accepts, and a retry can hit any transport failure. Keep
      // the ORIGINAL starvation error as the one that surfaces: it is statusless and marked, which is
      // what makes callLLM's cross-lane salvage (with bumpStarvedBudget) still run. The cause is not
      // lost — it rides on the receipt below.
      retryErr = err;
      error = String((err as Error)?.message ?? err).slice(0, 300);
    }
    // Fires on EVERY starvation, retry landed or not — a starving lane is a pattern, and `ok: false`
    // twice in a row is what says the cap was never the whole story.
    record({
      type: 'event', label: 'llm:starved_retry', role: req.role,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      detail: { role: req.role, model, cap, retriedCap, ok, ...(error ? { error } : {}) },
    });
    // A cancelled retry surfaces as the cancellation it is. callLLM checks the signal rather than
    // the error, so the abort is honoured either way — but dressing it up as starvation would put a
    // starvation line in the error log for a turn the caller simply walked away from.
    if (retryErr !== undefined && req.signal?.aborted) throw retryErr;
    if (!ok) throw starvedError(provider, model, starvedCap);
  }
  // The unretried throw (flag off), and the shape callers have always seen: a status-less error is
  // retryable per shouldFallback, so callLLM salvages the turn on a fallback lane, and the message
  // lands in traces via the ERROR record path. starvedError also MARKS the error, which is how
  // callLLM knows to retry with a BIGGER budget rather than re-sending the same cap to a second
  // model that would starve on it too.
  if (isLengthStarved(choice)) {
    throw starvedError(provider, model, params.max_tokens ?? MAX_TOKENS[req.role]);
  }
  const toolCalls: LlmResult['toolCalls'] = [];
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type === 'function') {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore malformed */ }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }
  }
  const u = resp.usage;
  // Server-tool text is an OpenRouter concept; a generic OpenAI endpoint returns none, so this is a
  // harmless no-op on the openai lane.
  const serverToolText = fromOpenRouterMessage(choice.message);
  return {
    text: choice.message.content || null,
    toolCalls,
    stopReason: choice.finish_reason ?? null,
    truncated: isTruncatedStop(choice.finish_reason),
    provider,
    model,
    usage: u
      ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      : undefined,
    serverToolText: serverToolText || undefined,
    raw: resp,
  };
}

function runOn(provider: LlmProvider, req: LlmRequest): Promise<LlmResult> {
  if (provider === 'anthropic') return callAnthropic(req);
  return callOpenAICompatible(req, provider);
}

/** Which lane actually runs a request. Injectable into callLLM ONLY so the lane policy (is the
 *  fallback attempted, which error surfaces) is unit-testable without touching a provider —
 *  production callers pass nothing. */
type LaneRunner = (provider: LlmProvider, req: LlmRequest) => Promise<LlmResult>;

/** A failed call must leave ALL THREE trails: an ERROR trace event (with the provider that
 *  failed — the dashboard renders it), a status='error' row in the durable ledger, and an
 *  error_log row (the cross-agent view, where a dead lane or a starving cap reads as a pattern
 *  instead of one row per role). `req` is the request as SENT — the starved-fallback leg passes
 *  its bumped copy, so maxTokensSent reports the budget that actually failed. */
function recordLlmError(req: LlmRequest, provider: LlmProvider, err: unknown, start: number): void {
  const message = String((err as Error)?.message ?? err);
  const model = req.modelOverride || MODELS[req.role][provider];
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  record({
    type: 'llm', role: req.role, label: req.trace?.label,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    provider, model,
    system: req.system, messages: req.messages, response: `ERROR: ${message}`,
    latencyMs: Date.now() - start,
  });
  // trace:false — the ERROR llm record above is already this turn's error event; a mirror here
  // would double-count it in error_count.
  reportError({
    source: req.role, category: 'llm_error', err,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    detail: { provider, model, label: req.trace?.label, maxTokensSent },
    trace: false,
  });
  void recordTokenUsage({
    handle: req.trace?.handle, chatId: req.trace?.chatId, taskId: req.trace?.taskId,
    role: req.role, label: req.trace?.label,
    provider, model,
    latencyMs: Date.now() - start, status: 'error', error: message,
    maxTokensSent,
  }).catch(() => { /* swallow: never surface analytics failures */ });
}

// Preferred fallback lane order per primary — the FIRST CONFIGURED one is used (a single fallback
// attempt, as before; now selected from three lanes instead of the old binary flip). Anthropic leads
// the OpenAI-compatible lanes' lists because it is first-party billing with hand-picked same-tier
// slugs — the only safe salvage target for the 402/bad-model exceptions in fallbackPolicy.
const FALLBACK_ORDER: Record<LlmProvider, readonly LlmProvider[]> = {
  openrouter: ['anthropic', 'openai'],
  openai: ['anthropic', 'openrouter'],
  anthropic: ['openrouter', 'openai'],
};

/**
 * Single entry point used by every agent. Each role has a PRIMARY provider (its <ROLE>_PROVIDER,
 * default Anthropic); on a transient failure it falls back to the first CONFIGURED other lane
 * (FALLBACK_ORDER). Usable means CONFIGURED — a lane whose key is unset or blank is never attempted,
 * on either side (see laneKeys.ts; no provider is "always available", not even Anthropic).
 * `run` is the lane dispatcher, injectable for unit tests only — production callers pass nothing.
 */
export async function callLLM(req: LlmRequest, run: LaneRunner = runOn): Promise<LlmResult> {
  const start = Date.now();
  const primary: LlmProvider = req.providerOverride ?? PROVIDERS[req.role];
  const fallback: LlmProvider | undefined = FALLBACK_ORDER[primary].find(p => isLaneConfigured(p));
  // No lane at all for this role: fail fast, before the budget gate and before any dispatch, with
  // both env vars named. Config precedes cost — and dispatching either lane could only produce an
  // SDK auth error from deep inside a request, which reads as provider trouble rather than as the
  // missing key it is.
  if (!isLaneConfigured(primary) && !fallback) {
    const err = noLaneConfiguredError(req.role);
    recordLlmError(req, primary, err, start);
    throw err;
  }
  // The cap sent to the PRIMARY lane, and (separately) the cap that actually produced the result —
  // they differ when a starved primary fell back on a bumped budget. The ledger records the served
  // one, so "output_tokens == max_tokens_sent" stays a reliable truncation signature.
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  let servedMaxTokens = maxTokensSent;
  // Budget gates run BEFORE any provider dispatch. BudgetExceededError is nonFallbackable (see
  // fallbackPolicy) — a tripped breaker must fail loud, never re-bill on the other lane. Recorded
  // like any failed call so the trip is visible in traces + the ledger.
  try {
    await checkCallBudgets(req);
  } catch (err) {
    recordLlmError(req, primary, err, start);
    throw err;
  }
  // Cross-provider fallback would re-parse any PDF with the OTHER provider's engine (Anthropic
  // native vision vs OpenRouter's file-parser/OCR). Document extraction persists the parsed facts
  // (dates/parties/amounts), so a silent engine swap on a transient blip could write subtly-wrong
  // data as status:'ok'. For document requests we therefore do NOT fall back by default — a clean
  // failure (the caller degrades gracefully) beats durably-wrong data. Callers whose output is
  // conversational (MM) may opt in via allowDocumentFallback — a slightly different PDF parse beats
  // no answer when the result isn't persisted as facts. Non-document requests unaffected.
  // Also never fall back when the request carries native audio/video: the MM route runs
  // primary=openrouter, and Anthropic can't take audio/video — a fallback would silently drop the
  // media (wrong answer) or 400. A clean failure (the caller degrades) is better.
  // 'unconfigured' is the third reason and the only one that logs: the lane has no key, so
  // attempting it can produce nothing but an auth error (see the skip branch below).
  const fallbackBlocked: 'document' | 'media' | 'unconfigured' | null =
    hasDocument(req) && !req.allowDocumentFallback ? 'document'
      : hasNativeMedia(req) ? 'media'
        : !fallback ? 'unconfigured'
          : null;

  let result: LlmResult;
  let fellBack = false;
  try {
    result = await run(primary, req);
  } catch (err) {
    // The caller's own signal is the authoritative abort check — SDK abort errors are unreliable
    // to sniff (Anthropic's APIUserAbortError never sets .name, so it reads as a generic Error).
    // A cancelled call must never re-bill on the other lane.
    if (req.signal?.aborted) {
      recordLlmError(req, primary, err, start);
      throw err;
    }
    if (!fallbackBlocked && fallback && shouldFallback(err, fallback)) {
      const status = (err as { status?: number })?.status ?? 'network';
      console.warn(`[llm] ${primary} call failed (${status}), falling back to ${fallback}`);
      // A starved primary must NOT be retried on the same budget: the whole cap went to reasoning,
      // and the other lane's model would spend it the same way. Double it (floored 1024, clamped to
      // the role ceiling) so the retry has room for actual content. Only the tiny per-call caps
      // really grow — a call already at its ceiling gets the same number back.
      const starved = isStarvedError(err);
      const retryMaxTokens = starved ? bumpStarvedBudget(maxTokensSent, MAX_TOKENS[req.role]) : undefined;
      const fbReq = retryMaxTokens !== undefined ? { ...req, maxTokens: retryMaxTokens } : req;
      // Make the lane switch visible: it shows in the orchestration graph and feeds
      // the health overview's fallback counter (console.warn alone hid every one).
      record({
        type: 'event', label: 'llm:fallback', role: req.role,
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
        detail: {
          from: primary, to: fallback,
          status,
          message: String((err as Error)?.message ?? err).slice(0, 300),
          ...(starved ? { reason: 'length_starved', maxTokensSent, retryMaxTokens } : {}),
        },
      });
      // Durable trail for EVERY lane switch, not just starvation: a lane that keeps failing is a
      // provider-health pattern, and the trace ring loses it on restart. No token_usage row for the
      // failed primary — status='error' there would double-count the call in llm_role_stats, which
      // already counts the (successful) fallback row. trace:false: the event above is the trail.
      reportError({
        source: req.role, category: 'llm_fallback', severity: 'warn',
        message: `${primary} lane failed (${status}) — falling back to ${fallback}`,
        detail: {
          from: primary, to: fallback, status,
          reason: starved ? 'length_starved' : 'transient',
          ...(starved ? { maxTokensSent, retryMaxTokens } : {}),
        },
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
        trace: false,
      });
      try {
        result = await run(fallback, fbReq);
        fellBack = true;
        if (retryMaxTokens !== undefined) servedMaxTokens = retryMaxTokens;
      } catch (fbErr) {
        // The fallback lane failing was previously recorded NOWHERE — leave both trails. fbReq, not
        // req: the bumped budget is what this leg actually sent.
        recordLlmError(fbReq, fallback, fbErr, start);
        throw fbErr;
      }
    } else {
      // No configured fallback lane, but the failure WOULD have salvaged — the single-key setup,
      // where one lane serves everything and the others sit blank in .env. It used to be attempted
      // anyway, and the SDK's "Could not resolve authentication method" from that leg replaced THIS
      // error — the one carrying the status the floor acts on. One warn line (trace:false —
      // recordLlmError below is this turn's error event) so a permanently keyless fallback still
      // reads as a pattern in the error log. Judged against the PREFERRED lane, even though it is
      // unconfigured, so the directional 402/bad-model salvage still gates the message correctly.
      const preferred = FALLBACK_ORDER[primary][0];
      if (fallbackBlocked === 'unconfigured' && shouldFallback(err, preferred)) {
        const status = (err as { status?: number })?.status ?? 'network';
        const missing = FALLBACK_ORDER[primary].map(laneEnvVar).join(' or ');
        reportError({
          source: req.role, category: 'llm_fallback', severity: 'warn',
          message: `${primary} lane failed (${status}) — no fallback lane configured (set ${missing})`,
          detail: { from: primary, to: null, status, reason: 'fallback_unconfigured', missing },
          chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
          trace: false,
        });
      }
      recordLlmError(req, primary, err, start);
      throw err;
    }
  }
  // toolsViaJson: the model WROTE its tool calls into the JSON envelope — parse them back into
  // result.toolCalls here, BEFORE record(), so tracing/the dashboard see them exactly like native
  // calls and every caller dispatches identically. Dedupe against any native calls (belt-and-braces:
  // a misconfig or a provider that tool-called anyway must not double-dispatch one action).
  if (req.toolsViaJson) {
    const envCalls = parseReply(result.text).toolCalls ?? [];
    if (envCalls.length) {
      const seen = new Set(result.toolCalls.map(t => `${t.name} ${JSON.stringify(t.input)}`));
      for (const c of envCalls) {
        const key = `${c.name} ${JSON.stringify(c.input)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.toolCalls.push({ name: c.name, input: c.input });
      }
    }
  }
  // Feed the task's budget (if one is registered for this taskId) — the single accounting path
  // that sees loop steps AND tool-internal calls alike.
  reportTaskUsage(req.trace?.taskId, result.usage);
  record({
    type: 'llm', role: req.role, label: req.trace?.label,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    provider: result.provider, model: result.model,
    system: req.system, messages: req.messages,
    response: result.text, toolCalls: result.toolCalls.map(t => ({ name: t.name, input: t.input })),
    raw: result.raw,
    latencyMs: Date.now() - start,
  });
  // The ONE seam where truncation-with-content is visible: the starvation guards above only catch
  // the empty case, and a reply that got cut off mid-sentence throws nothing at all — it just
  // returns short, so half-written dossiers persist and Judge verdicts lose their tool call. Every
  // lane and both fallback outcomes pass through here, so one report covers them; callers that must
  // fail CLOSED on a partial answer read result.truncated themselves.
  if (result.truncated) {
    const truncDetail = {
      provider: result.provider, model: result.model, stopReason: result.stopReason,
      maxTokensSent: servedMaxTokens,
      outputTokens: result.usage?.outputTokens ?? null,
      hasText: !!result.text?.trim(), toolCalls: result.toolCalls.length,
      ...(fellBack ? { fallbackFrom: primary } : {}),
    };
    record({
      type: 'event', label: 'llm:truncated', role: req.role,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      detail: truncDetail,
    });
    reportError({
      source: req.role, category: 'truncation', severity: 'warn',
      message: `${result.model} cut off at the completion cap (stop_reason=${result.stopReason}, `
        + `output=${result.usage?.outputTokens ?? '?'}/${servedMaxTokens})`,
      detail: truncDetail,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      trace: false,   // the llm:truncated event above is the trail
    });
  }
  // Persist the call in the durable ledger (per-call, bound to the channel identity via
  // trace.handle). Recorded even when the provider returned no usage (zeros) so call
  // counts stay complete. Fire-and-forget: analytics must never break a reply.
  void recordTokenUsage({
    handle: req.trace?.handle, chatId: req.trace?.chatId, taskId: req.trace?.taskId,
    role: req.role, label: req.trace?.label,
    provider: result.provider, model: result.model, usage: result.usage,
    latencyMs: Date.now() - start,
    fallbackFrom: fellBack ? primary : undefined,
    status: 'ok',
    // Truncated calls stay status='ok' (a third status would drop them from llm_role_stats /
    // llm_hourly, which count status in ('ok','error')) — the flag is how they're found.
    stopReason: result.stopReason ?? undefined,
    maxTokensSent: servedMaxTokens,
    truncated: result.truncated,
  }).catch(() => { /* swallow: never surface analytics failures */ });
  return result;
}

export type { LlmRequest, LlmResult } from './types.js';
