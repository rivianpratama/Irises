import OpenAI from 'openai';
import { MODELS, MAX_TOKENS, THINKING, EFFORT, CACHE_SYSTEM, TEMPERATURE } from './models.js';
import type { EffortLevel } from './models.js';
import { BUBBLE_ENVELOPE_SCHEMA, buildEnvelopeSchema } from '../pipeline/bubbleJson.js';
import { renderTimestamps } from './timedMessages.js';
import type { LlmRequest, LlmContentBlock, LlmToolDef } from './types.js';

// Pure OpenRouter request-shaping — no SDK client, no I/O, so it's unit-testable without keys.
// callLLM.ts owns the actual network call + response parsing.

// PDF parsing engine for OpenRouter's file-parser plugin. Default: Cloudflare AI (free — converts
// text + scanned PDFs to markdown). Override with 'mistral-ocr' (paid, best for heavy scans) or
// 'native' (only for file-native models, billed as input tokens). See:
// https://openrouter.ai/docs/guides/overview/multimodal/pdfs
const OPENROUTER_PDF_ENGINE = process.env.OPENROUTER_PDF_ENGINE || 'cloudflare-ai';

export function toOpenRouterContent(
  content: string | LlmContentBlock[],
): OpenAI.Chat.Completions.ChatCompletionContentPart[] | string {
  if (typeof content === 'string') return content;
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const b of content) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: b.url } });
    // Native audio: OpenRouter wants a bare base64 string + a format string (NOT a data: URL). The
    // base64 is filled by the media inliner; drop the block if it's somehow still un-inlined (a
    // partial input_audio part would 400). Same SDK-cast precedent as the file part below.
    else if (b.type === 'audio') {
      if (!b.data) { console.warn('[llm] audio block missing inlined data — dropping'); continue; }
      parts.push({
        type: 'input_audio',
        input_audio: { data: b.data, format: b.format ?? 'm4a' },
      } as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart);
    }
    // Native video: a data:<mime>;base64,… URL (Gemini/Vertex can't fetch CDN links). base64 filled
    // by the inliner; drop if missing.
    else if (b.type === 'video') {
      if (!b.data) { console.warn('[llm] video block missing inlined data — dropping'); continue; }
      parts.push({
        type: 'video_url',
        video_url: { url: `data:${b.mimeType};base64,${b.data}` },
      } as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart);
    }
    // PDF/document: OpenRouter parses it server-side via the file-parser plugin (attached below),
    // so — unlike the old fallback — the contract text actually reaches the model.
    else if (b.type === 'document') parts.push({
      type: 'file',
      file: { filename: 'document.pdf', file_data: `data:${b.mediaType};base64,${b.data}` },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart);
  }
  return parts;
}

export function toOpenRouterTools(tools: LlmToolDef[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** True when any message carries a PDF/document block (drives the file-parser plugin). */
export function hasDocument(req: LlmRequest): boolean {
  return req.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'document'));
}

/** True when any message carries native audio/video — OpenRouter-only (Anthropic can't run these). */
export function hasNativeMedia(req: LlmRequest): boolean {
  return req.messages.some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'audio' || b.type === 'video'));
}

/** OpenRouter create-params plus the non-SDK body fields `plugins` (file-parser), `reasoning`, and
 *  `provider` (routing prefs, e.g. require_parameters for structured outputs). */
export type OpenRouterParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { plugins?: unknown[]; reasoning?: unknown; provider?: Record<string, unknown>; max_tool_calls?: number };

// Per-request unit-price ceiling ($/Mtok) on OpenRouter provider routing. A FILTER on provider
// unit pricing, NOT a total-spend cap — it protects against expensive-provider/model drift, but it
// does nothing about token VOLUME (the volume caps are the web-search limits below + the budget
// guards in budget.ts). Unset = off.
const MAX_PRICE_PROMPT = Number(process.env.OPENROUTER_MAX_PRICE_PROMPT || 0);
const MAX_PRICE_COMPLETION = Number(process.env.OPENROUTER_MAX_PRICE_COMPLETION || 0);

// Request-level ceiling on server-side tool invocations for EVERY OpenRouter request, even ones
// with NO web_search tool attached. OpenRouter's own default is 30/request — a deep-research model
// browses internally and bills every fetched page as prompt tokens, and a role can run such a model
// with web search OFF, so without a ceiling here it rides that 30.
// 8 bounds that internal browsing while staying >= OPS_MAX_TOOL_CALLS_PER_STEP (6) in case a
// provider ever counts client tool calls against this. When web_search IS on, webSearchMaxUses wins
// (below). 0 = omit the field entirely (emergency lever / opt-out). Invalid → the 8 default.
function parseMaxToolCalls(): number {
  const raw = (process.env.OPENROUTER_MAX_TOOL_CALLS_DEFAULT || '').trim();
  if (raw === '') return 8;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[llm] OPENROUTER_MAX_TOOL_CALLS_DEFAULT="${raw}" invalid — using 8`);
    return 8;
  }
  return Math.floor(n);
}
const MAX_TOOL_CALLS_DEFAULT = parseMaxToolCalls();

// OpenRouter's unified `reasoning` param caps at effort 'high' (no xhigh/max/adaptive) — map down.
function toOpenRouterEffort(effort: EffortLevel | null): 'low' | 'medium' | 'high' | null {
  if (!effort) return null;
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}

/**
 * Say "no reasoning" OUT LOUD on requests whose role has none armed (env LLM_REASONING_DISABLE,
 * default on, read at call time, parsed like threadingEnabled()).
 *
 * Omitting the field does not mean no reasoning — it means the MODEL's default decides. Engine
 * discovery puts the host engine's model on EVERY voice role (agents/ops/engineDiscovery.ts's
 * applyModel), so a reasoning-family engine model runs the classify lane, whose per-call caps are
 * tiny by design (the climate eval's 200, validateDirective's 20, updateDossier's 900). The whole cap
 * goes to thinking and the reply arrives with finish_reason='length' and nothing in it — the
 * starvation shape isLengthStarved names below, and the reason the relationship climate never moved
 * in production.
 *
 * Scope: unarmed roles whose body does NOT set jsonBubbles. A jsonBubbles body also sends
 * `provider: { require_parameters: true }`, which routes only to providers that support every param
 * in it, so one more field can narrow routing to nothing — see buildOpenRouterParams. The lane that
 * actually starves (classify: the climate eval, validateDirective, the dossier) sends no jsonBubbles,
 * and the roles that do (convo/fallfirm/composer) run four-figure ceilings.
 *
 * The field: `reasoning: { enabled: false }` — the exact inverse of the `{ enabled: true, effort }`
 * this file already sends, `enabled` being a documented boolean of OpenRouter's unified reasoning
 * param. We deliberately do NOT send the other documented off-switch, `effort: 'none'`: models with
 * mandatory reasoning REJECT it, and a 400 on every classify call is worse than a starved one (which
 * at least salvages on another lane). An ignored `enabled: false` therefore degrades to exactly
 * today's behavior, and the starved retry below does not depend on it either way.
 *
 * Off → the field is omitted exactly as before, on every role.
 */
export function reasoningDisableEnabled(): boolean {
  const v = (process.env.LLM_REASONING_DISABLE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The ONE bounded same-lane retry after a starved reply (env LLM_STARVED_RETRY, default on, read at
 *  call time, parsed like threadingEnabled()). Off → the starved reply throws straight to the
 *  cross-lane fallback, byte for byte as before. Lives beside the detector it reacts to. */
export function starvedRetryEnabled(): boolean {
  const v = (process.env.LLM_STARVED_RETRY || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The hard wall clock on ONE voice-lane call: 120 seconds. Nothing conversational is worth more —
 *  a reply nobody is still waiting for is not a reply. */
export const LLM_CALL_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * How long a single voice call may take before it is aborted and treated as a provider failure
 * (env LLM_CALL_TIMEOUT_MS, default on at LLM_CALL_TIMEOUT_DEFAULT_MS, read at call time, parsed
 * like the two flags above). `null` = no wall clock at all, which is what the code did before:
 * a local Convo call hung 25 minutes on the OpenRouter lane (`agent: 1516078ms`) because the only
 * bounds in play were the SDK's own 600s timeout times its retries.
 *
 * `0`/`off`/`false`/`no` is that old behavior back, byte for byte; a positive number is taken as
 * written; junk falls back to the default rather than removing the bound. Lives beside its siblings,
 * and applies to every lane (the hang was on OpenRouter, but nothing here is lane-specific).
 */
export function llmCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.LLM_CALL_TIMEOUT_MS || '').trim().toLowerCase();
  if (raw === '') return LLM_CALL_TIMEOUT_DEFAULT_MS;
  if (['0', 'off', 'false', 'no'].includes(raw)) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : LLM_CALL_TIMEOUT_DEFAULT_MS;
}

/**
 * The GENERIC OpenAI Chat Completions body, shared by both OpenAI-compatible lanes (`openrouter`
 * and `openai`). Nothing OpenRouter-proprietary here — no cache_control, no `openrouter:web_search`
 * server tool, no `reasoning`/`provider`/`plugins`/`max_tool_calls`. A stock OpenAI-compatible
 * endpoint (OpenAI, Azure, vLLM, LiteLLM, Groq, …) accepts every field this emits. `model` is passed
 * in because it is lane-specific (MODELS[role].openrouter vs .openai). Exported for unit tests.
 */
export function buildBaseParams(
  req: LlmRequest,
  model: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  // Structured message timestamps become in-band content here (the API rejects unknown keys).
  for (const m of renderTimestamps(req.messages)) {
    messages.push({ role: m.role, content: toOpenRouterContent(m.content) } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
  }

  // toolsViaJson: the tools are NOT sent natively — they live in the extended response_format
  // schema (tool_calls field) + the system prompt's tool docs instead. Sending both channels at
  // once is the one way to get double-dispatch of the same action, so this is strictly either/or.
  const tools = !req.toolsViaJson && req.tools?.length ? toOpenRouterTools(req.tools) : [];

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? MAX_TOKENS[req.role],
    messages,
  };
  const temp = req.temperature ?? TEMPERATURE[req.role] ?? undefined;
  if (temp !== undefined) params.temperature = temp;
  if (tools.length) params.tools = tools;
  // Force schema-valid bubble JSON at the API (OpenAI structured outputs). This IS generic — OpenAI,
  // Azure OpenAI and most gateways support json_schema; an endpoint that lacks it fails loud and
  // callLLM salvages the turn on another lane (there is no silent-drop retry on this path).
  if (req.jsonBubbles) {
    const schema = req.envelopeSchema ?? (req.toolsViaJson ? buildEnvelopeSchema(req.tools) : BUBBLE_ENVELOPE_SCHEMA);
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: 'irises_reply', strict: true, schema },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];
  }
  return params;
}

/** The generic `openai` lane params — the base body with its own model slug and NO OpenRouter
 *  extras. This is what lets Irises's voice reach any OpenAI-compatible endpoint via OPENAI_BASE_URL. */
export function buildOpenAIParams(req: LlmRequest): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return buildBaseParams(req, req.modelOverride || MODELS[req.role].openai);
}

/** The `openrouter` lane params: the generic base PLUS OpenRouter-proprietary extras (cache_control
 *  passthrough, the openrouter:web_search server tool, unified `reasoning`, provider routing prefs,
 *  max_tool_calls, and the file-parser/response-healing plugins). None of these are sent on the
 *  generic `openai` lane, which would 400 on them. */
export function buildOpenRouterParams(
  req: LlmRequest,
  opts?: { disableReasoning?: boolean },
): OpenRouterParams {
  const params = buildBaseParams(req, req.modelOverride || MODELS[req.role].openrouter) as OpenRouterParams;

  // Cache the stable system prefix via Anthropic-through-OpenRouter cache_control passthrough
  // (harmlessly ignored by non-Anthropic experiment models). Replace the plain system message the
  // base builder emitted at index 0.
  if (req.system && CACHE_SYSTEM[req.role]) {
    params.messages[0] = {
      role: 'system',
      content: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  }

  // OpenRouter runs web_search server-side and folds the results into the reply (no client
  // round-trip) — the cross-provider analogue of Anthropic's native web_search. The SDK doesn't
  // type this server-tool entry, hence the cast.
  // https://openrouter.ai/docs/guides/features/server-tools/web-search
  // max_uses MUST be set: uncapped, a deep-research model browses freely and every fetched page is
  // billed as prompt tokens. Mirrors the Anthropic lane's web_search max_uses.
  if (req.enableWebSearch) {
    const tools = (params.tools ?? []) as OpenAI.Chat.Completions.ChatCompletionTool[];
    tools.push({
      type: 'openrouter:web_search',
      parameters: { max_uses: req.webSearchMaxUses ?? 3 },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionTool);
    params.tools = tools;
  }

  // Reasoning (adaptive thinking / effort) for opted-in roles. OpenRouter is the experiment lane, so
  // send it whenever configured and let the chosen model honor it (effort capped to 'high' above).
  // The other direction is just as load-bearing: a role with NOTHING armed says so explicitly, so an
  // inherited reasoning model can't spend a 200-token cap on thinking (see reasoningDisableEnabled).
  // `opts.disableReasoning` is the starved retry, which overrides even an armed role — the whole
  // point of that leg is that thinking is what ate the first budget.
  // NOT on a jsonBubbles body: those set provider.require_parameters below, which routes only to
  // providers supporting EVERY param sent — an extra `reasoning` there can leave a non-reasoning
  // model with no eligible provider, and convo/fallfirm/composer are all jsonBubbles with nothing
  // armed, so that failure would land on the PRIMARY VOICE call every turn. They also don't need it:
  // their ceilings are thousands of tokens, not the classify lane's 20-900. The retry leg still
  // sends it (opts.disableReasoning) — by then the call has already starved, and if routing then
  // finds nothing the original starvation error surfaces to the cross-lane salvage as before.
  const orEffort = toOpenRouterEffort(EFFORT[req.role]);
  const armed = THINKING[req.role] || !!orEffort;
  if (opts?.disableReasoning) params.reasoning = { enabled: false };
  else if (armed) params.reasoning = { enabled: true, ...(orEffort ? { effort: orEffort } : {}) };
  else if (reasoningDisableEnabled() && !req.jsonBubbles) params.reasoning = { enabled: false };

  // Request-level ceiling on server-tool invocations (OpenRouter's default is 30 — far too loose for
  // a cost-bounded agent, and it applies even with NO web_search tool: a deep-research model browses
  // server-side regardless). Web search ON → the web-search cap wins; OFF → the always-on default
  // (see MAX_TOOL_CALLS_DEFAULT above; 0 disables the field).
  if (req.enableWebSearch) params.max_tool_calls = req.webSearchMaxUses ?? 3;
  else if (MAX_TOOL_CALLS_DEFAULT > 0) params.max_tool_calls = MAX_TOOL_CALLS_DEFAULT;

  // response_format is already on params (base builder). On OpenRouter it needs require_parameters
  // routing so it lands only on a provider that supports every param we send — several
  // deepseek-v4-flash providers accept response_format but lack structured_outputs and silently drop
  // the schema, letting prose slip out. Fail loud rather than silently drop the constraint.
  if (req.jsonBubbles) {
    params.provider = { ...(params.provider ?? {}), require_parameters: true };
  }
  // Unit-price ceiling (see MAX_PRICE_* note above) — merged so jsonBubbles' require_parameters
  // and this filter coexist on params.provider.
  if (MAX_PRICE_PROMPT > 0 || MAX_PRICE_COMPLETION > 0) {
    params.provider = {
      ...(params.provider ?? {}),
      max_price: {
        ...(MAX_PRICE_PROMPT > 0 ? { prompt: MAX_PRICE_PROMPT } : {}),
        ...(MAX_PRICE_COMPLETION > 0 ? { completion: MAX_PRICE_COMPLETION } : {}),
      },
    };
  }
  // Plugins are MERGED (an mm turn can carry a PDF and need both):
  //   - response-healing: free server-side repair of near-JSON replies (non-streaming only, which is
  //     all we do) — belt-and-braces under the toolsViaJson never-non-JSON guarantee. It can't help
  //     when a provider drops response_format entirely, so the client-side retry still backstops it.
  //   - file-parser: only when a PDF is actually present, so plain-text calls stay unaffected.
  const plugins: unknown[] = [];
  if (req.toolsViaJson && req.jsonBubbles) plugins.push({ id: 'response-healing' });
  if (hasDocument(req)) plugins.push({ id: 'file-parser', pdf: { engine: OPENROUTER_PDF_ENGINE } });
  if (plugins.length) params.plugins = plugins;
  return params;
}

/**
 * True when an OpenRouter reply ran out of max_tokens with NOTHING usable — the reasoning-model
 * starvation mode: on OpenRouter, chain-of-thought tokens count against max_tokens, so a model
 * like deepseek-v4-flash can spend the entire completion budget thinking and get cut off
 * (finish_reason='length') before emitting a single content token or tool call. That reply is not
 * "empty" — it's a deterministic failure the caller must treat as retryable (cross-provider
 * fallback), or the identical retry starves identically. A 'length' finish WITH partial content is
 * NOT starvation: that's an ordinary long-but-usable truncation.
 */
export function isLengthStarved(choice: {
  finish_reason: string | null;
  message: { content: string | null; tool_calls?: unknown[] | null };
}): boolean {
  return choice.finish_reason === 'length' && !choice.message.content && !choice.message.tool_calls?.length;
}
