// Provider-neutral LLM shapes so agents never import SDK types directly.

export type LlmRole = 'convo' | 'ops' | 'classify' | 'fallfirm';
// Three lanes. `anthropic` is the native SDK; `openrouter` and `openai` are BOTH the OpenAI SDK —
// openrouter points at openrouter.ai (with its proprietary body extras), `openai` is the generic
// OpenAI-compatible lane whose base URL is env-configurable (OPENAI_BASE_URL), so a host engine on
// any OpenAI-shaped API (OpenAI/Azure/vLLM/LiteLLM/Groq/Together/deepseek-direct/ollama/…) is
// reachable by Irises's own voice. See openrouterRequest.buildOpenAIParams vs buildOpenRouterParams.
export type LlmProvider = 'anthropic' | 'openrouter' | 'openai';

export interface LlmTextBlock { type: 'text'; text: string }
export interface LlmImageBlock { type: 'image'; url: string; mimeType?: string }
/** PDF/document block — Anthropic-native (used for document extraction). */
export interface LlmDocumentBlock { type: 'document'; mediaType: string; data: string } // base64
/**
 * Native audio for the OpenRouter multimodal route (input_audio). Carries a remote `url` +
 * `mimeType` when built from an inbound media part; the OpenRouter inliner fills `data` (base64) +
 * `format` at the provider boundary (its wire shape is a bare base64 string + a format string, NOT
 * a data: URL). Anthropic has no native audio, so these must not reach it (see hasNativeMedia).
 */
export interface LlmAudioBlock { type: 'audio'; url?: string; mimeType: string; data?: string; format?: string }
/**
 * Native video for the OpenRouter multimodal route (video_url). Like audio, carries a remote `url` +
 * `mimeType` pre-inline; the inliner fills `data` (base64) and the mapper wraps it into a
 * `data:<mime>;base64,…` URL. Anthropic-unsupported (see hasNativeMedia).
 */
export interface LlmVideoBlock { type: 'video'; url?: string; mimeType: string; data?: string }
export type LlmContentBlock =
  | LlmTextBlock | LlmImageBlock | LlmDocumentBlock | LlmAudioBlock | LlmVideoBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  /**
   * Human-readable local label of when this message happened — always the full date + clock,
   * "Mon, Jul 6, 9:14 PM" (see chatTime.timestampLabel). INTERNAL structured field:
   * the provider APIs reject unknown message keys, so renderTimestamps (llm/timedMessages.ts)
   * folds it into the wire content at the provider boundary — a `[label]` prefix on string
   * content, or a leading text block on block content. Diagnostics/traces see it structured.
   */
  timestamp?: string;
  content: string | LlmContentBlock[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmRequest {
  role: LlmRole;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  temperature?: number;
  enableWebSearch?: boolean; // Anthropic native web_search OR OpenRouter's openrouter:web_search server tool
  webSearchMaxUses?: number; // cap searches per request on BOTH lanes (Anthropic max_uses; OpenRouter parameters.max_uses + max_tool_calls). Default 3 — uncapped server-side search is billed as prompt tokens.
  modelOverride?: string;
  providerOverride?: LlmProvider; // force the primary provider for this call, ignoring the role default
  // Opt in to cross-provider fallback even when the request carries document blocks. Default is
  // false: the engine-swap concern (Anthropic vision vs OpenRouter file-parser producing subtly
  // different parses) makes fallback unsafe for Ops document extraction where parsed facts persist.
  // Callers whose output is conversational (MM) may set this — a slightly different PDF parse beats
  // no answer. Does NOT override hasNativeMedia: audio/video still blocks fallback unconditionally.
  allowDocumentFallback?: boolean;
  // Force schema-valid bubble-envelope JSON at the API on BOTH providers: OpenRouter structured
  // outputs (response_format: json_schema) and Anthropic structured outputs (output_config.format).
  // Set on the user-facing bubble producers. Enforcing on the Anthropic path too is load-bearing:
  // it's the transient-error FALLBACK for the OpenRouter-primary chat roles, and an unenforced
  // fallback turn is exactly where prose used to slip out to the bubble splitter.
  jsonBubbles?: boolean;
  // Custom envelope schema for a jsonBubbles role whose reply carries extra structured fields
  // beyond the shared bubble envelope (MM's {could_not_open, analysis, bubbles}). Only read when
  // jsonBubbles is set; it replaces the default schema at BOTH provider boundaries. Parsing the
  // extra fields back out stays the caller's job (parseMmReply, not parseReply).
  envelopeSchema?: Record<string, unknown>;
  // Written tool calls (single-shot roles only — Convo never sees a tool result). The
  // request's `tools` are NOT sent as the native API param; instead they (a) build the extended
  // envelope schema (buildEnvelopeSchema: a `tool_calls` field with a hard name enum) and (b) are
  // documented in the system prompt. The model WRITES its tool calls into the JSON reply; callLLM
  // parses them back into result.toolCalls, so callers dispatch identically. Why: native `tools` +
  // response_format coexistence is provider-dependent on OpenRouter — several deepseek-v4-flash
  // providers silently drop the schema when both are present, which is exactly how prose "let me
  // search" turns with no tool call and no confidence slipped out. One output channel fixes it.
  // Requires jsonBubbles. NEVER set alongside a role that needs a real multi-turn tool loop (Ops).
  toolsViaJson?: boolean;
  // Where the STABLE, cache-reusable prefixes of `system` end, as character offsets in ascending
  // order — Convo passes two (agents/convo/promptSections.ts promptCacheBreakpoints): the static
  // persona head, and the end of its system message, which is stable within a chat (its per-turn
  // tail rides in `messages`, after the history). When set AND the role opts into caching
  // (CACHE_SYSTEM[role]), the Anthropic path emits one `cache_control` block per span plus an
  // uncached remainder when one is left, so a cache read matches everything up to the last offset
  // that hasn't changed. Without any of them, a role whose system carries ANY per-turn-varying part
  // would cache-WRITE the whole system every call: zero reads, plus a ~25% write premium, and the
  // write tokens still count toward the daily cap. Offsets outside (0, system.length] or that don't
  // advance are ignored, at most
  // MAX_CACHE_BREAKPOINTS are used, and the whole field is ignored on the OpenRouter/OpenAI lanes
  // (prompt caching is Anthropic-only; Convo's OpenRouter primary is deepseek).
  systemCacheBreakpoints?: readonly number[];
  // Cancels the in-flight HTTP request at both SDKs. Long Ops calls can run for minutes; without
  // this, a task timeout only stops the loop BETWEEN steps while the abandoned request keeps
  // billing to completion.
  signal?: AbortSignal;
  /**
   * Opt in to STREAMING on the OpenAI-compatible lanes (openrouter + openai): each non-empty content
   * delta is handed here as it arrives, so a caller can start acting on the reply before the whole
   * completion exists. Reasoning deltas never reach it. The returned LlmResult is the same shape as
   * a non-streamed call's (the full accumulated text, usage from the final chunk), plus `emitted`.
   * The Anthropic lane IGNORES it: that call stays a single accumulated result, so a turn that
   * falls back there simply gets no deltas and `emitted` stays unset.
   * Once a delta has gone out, a failure no longer throws (see LlmResult.emitted).
   */
  onTextDelta?: (delta: string) => void;
  trace?: TraceTag;          // optional diagnostics tagging (see src/diagnostics)
}

export interface TraceTag {
  chatId?: string;
  handle?: string;
  taskId?: string;
  label?: string;
}

/** Token usage for one LLM call. Cache fields are Anthropic-only (0 on the OpenRouter fallback). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface LlmResult {
  text: string | null;
  toolCalls: LlmToolCall[];
  stopReason: string | null;
  /** The completion hit its max_tokens cap — normalized across the lanes' different spellings
   *  ('max_tokens' on Anthropic, 'length' on OpenRouter; see llm/truncation.isTruncatedStop).
   *  Required, not optional: a guard that reads `stopReason === 'length'` is silently dead on the
   *  Anthropic lane, which is exactly how truncated dossiers and downgraded urgent mail happened.
   *  Callers whose output persists or is user-visible must check this before trusting the result. */
  truncated: boolean;
  provider: LlmProvider;
  model: string;
  usage?: LlmUsage;          // optional: not every provider path reports usage
  /** The completion cap that actually PRODUCED this reply, when the lane raised it mid-call — i.e.
   *  the starved retry's bigger budget (llm/callLLM.callOpenAICompatible). Undefined means "the cap
   *  the request asked for", which is what callLLM assumes. It exists because callLLM records
   *  max_tokens_sent in the durable ledger and on the llm:truncated trail, and a row saying
   *  `output_tokens=600 / max_tokens_sent=200` describes a call that never happened — the
   *  "output_tokens == max_tokens_sent is a truncation signature" property depends on the SERVED
   *  cap. Never a request field: callers set maxTokens, lanes report what they served. */
  servedMaxTokens?: number;
  /** Human-readable text harvested from SERVER-SIDE web-search results (titles/urls/cited snippets),
   *  when the turn ran web_search. Undefined when no web results were returned. Ops seeds this into
   *  its grounding corpus so a legitimately web-sourced fact isn't flagged ungrounded (see
   *  llm/serverToolText.ts). Diagnostics-adjacent — never the reply text itself. */
  serverToolText?: string;
  /** The provider's UNPARSED wire response body, for diagnostics only (never used by agents).
   *  Anthropic: the Message object (an array of them when pause_turn continuations occurred).
   *  OpenRouter: the full chat.completion object. */
  raw?: unknown;
  /** The serialized wire REQUEST body handed to the provider — the "RAW sent prompt" the dashboard
   *  shows next to `raw`. This is the actual body (model, system, tools, params and the fully
   *  rendered messages), NOT Irises' internal req.messages. Diagnostics only, never read by agents.
   *  Anthropic: the params bag (an array of legs when pause_turn continuations occurred).
   *  OpenAI-compatible: the served body — the retry's body when a starved retry landed, so it pairs
   *  with the `raw` response leg that actually answered. */
  rawRequest?: unknown;
  /** Set on a STREAMED call (LlmRequest.onTextDelta): true when at least one delta was delivered to
   *  the sink. Load-bearing past that point: text the caller may already have sent cannot be taken
   *  back, so a stream that breaks (or a call that times out) after emitting RETURNS what
   *  accumulated with stopReason 'error' instead of throwing, and neither the same-lane starved
   *  retry nor the cross-lane fallback runs — both would produce a second, different reply to a
   *  turn whose first one is already on its way out. Recovering from the partial is the caller's
   *  job. Unset on non-streamed calls. */
  emitted?: boolean;
}
