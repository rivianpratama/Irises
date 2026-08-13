// Provider-neutral LLM shapes so agents never import SDK types directly.

export type LlmRole = 'convo' | 'ops' | 'classify' | 'fallfirm';
export type LlmProvider = 'anthropic' | 'openrouter';

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
  // The number of leading characters of `system` that form the STABLE, cache-reusable prefix (e.g.
  // Convo's static persona, which precedes the per-turn dynamic sections). When set AND the role opts
  // into caching (CACHE_SYSTEM[role]), the Anthropic path emits the system as TWO blocks — a cached
  // prefix [0, len) + an uncached remainder [len, end) — so prompt caching matches the persona across
  // turns. Without it, a role whose system carries ANY per-turn-varying tail (Convo embeds the current
  // time to ms) would cache-WRITE the whole system every call: zero reads, plus a ~25% write premium,
  // and the write tokens still count toward the daily cap. Ignored when unset, <=0, or >= system.length,
  // and on the OpenRouter lane (prompt caching is Anthropic-only; Convo's OpenRouter primary is deepseek).
  systemCachePrefixLen?: number;
  // Cancels the in-flight HTTP request at both SDKs. Long Ops calls can run for minutes; without
  // this, a task timeout only stops the loop BETWEEN steps while the abandoned request keeps
  // billing to completion.
  signal?: AbortSignal;
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
  /** Human-readable text harvested from SERVER-SIDE web-search results (titles/urls/cited snippets),
   *  when the turn ran web_search. Undefined when no web results were returned. Ops seeds this into
   *  its grounding corpus so a legitimately web-sourced fact isn't flagged ungrounded (see
   *  llm/serverToolText.ts). Diagnostics-adjacent — never the reply text itself. */
  serverToolText?: string;
  /** The provider's UNPARSED wire response body, for diagnostics only (never used by agents).
   *  Anthropic: the Message object (an array of them when pause_turn continuations occurred).
   *  OpenRouter: the full chat.completion object. */
  raw?: unknown;
}
