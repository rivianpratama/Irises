import type { LlmRole, LlmProvider } from './types.js';

// Role -> the model slug on each provider. EVERY slot is overridable from .env so models
// can be tuned without code changes. Which provider runs FIRST for a role is set by
// PROVIDERS (below); the other provider is the automatic transient-error fallback.
// Confirm live slugs before shipping.
export const MODELS: Record<LlmRole, { anthropic: string; openrouter: string }> = {
  // Convo's Anthropic slot is the transient-error FALLBACK (OpenRouter/DeepSeek is primary). It
  // must be a structured-outputs-capable model (output_config.format carries the tool_calls
  // envelope) — Sonnet 4.6 is NOT (it would 400 into the unenforced path); Sonnet 5 is.
  convo: {
    anthropic: process.env.CONVO_MODEL || 'claude-sonnet-5',
    openrouter: process.env.CONVO_MODEL_OPENROUTER || 'deepseek/deepseek-v4-flash',
  },
  ops: {
    anthropic: process.env.OPS_MODEL || 'claude-opus-4-8',
    openrouter: process.env.OPS_MODEL_OPENROUTER || 'anthropic/claude-opus-4.8',
  },
  // Ops-Escalation: the "second opinion" engine. When a first Ops run FAILS (times out, hits a
  // provider snag, or comes back ungrounded/empty for a researchable reason), the orchestrator runs
  // ONE more look on THIS role. The CODE defaults below keep a same-family Opus slug on BOTH lanes so
  // an UNSET deploy is safe — a fallback flip must never be a billing surprise. Fully env-tunable at
  // deploy (OPS_ESCALATION_*), bounded by the per-leg task budget + daily cap + timeout + tool-call
  // ceiling. Provider defaults to anthropic (below). A pure transient LLM lane error does not reach
  // this leg directly — it takes the cheap same-role OPS_RETRY path first, and only ladders here if
  // that retry itself returns a researchable miss (see OPS_RETRY_ENABLED below).
  ops_escalation: {
    anthropic: process.env.OPS_ESCALATION_MODEL || 'claude-opus-4-8',
    openrouter: process.env.OPS_ESCALATION_MODEL_OPENROUTER || 'anthropic/claude-opus-4.8',
  },
  // Ops-MM: the Ops engine's OWN media reader — audio/video email attachments (read_attachment
  // tool). This is independent of the MM agent: Ops stays multimodal for attachments it pulls from
  // Gmail itself. The Ops-tier models can't take native audio/video, so this role runs a file-native
  // model on OpenRouter (same lane class as the mm role, but tuned/priced independently). OpenRouter-
  // only, no fallback (hasNativeMedia blocks it — Anthropic can't run these). The anthropic slug is a
  // required placeholder.
  ops_mm: {
    anthropic: process.env.OPS_MM_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.OPS_MM_MODEL_OPENROUTER || 'google/gemini-3.5-flash',
  },
  classify: {
    anthropic: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.CLASSIFY_MODEL_OPENROUTER || 'anthropic/claude-haiku-4.5',
  },
  // Autonome: Irises's proactive outreach voice. Haiku-tier like Convo/Composer —
  // it composes text only (Ops does any tool work before it voices).
  autonome: {
    anthropic: process.env.AUTONOME_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.AUTONOME_MODEL_OPENROUTER || 'anthropic/claude-haiku-4.5',
  },
  // Judge: discerns inbound email importance/severity/fraud for the user
  // and, when it matters, voices the proactive surfacing in Irises's tone. Sonnet-tier —
  // a deliberate, nuanced read (fraud, ambiguous leads) sits above Haiku but below the
  // Opus research engine. Runs on every inbound email, so the tier is a cost/quality call.
  judge: {
    anthropic: process.env.JUDGE_MODEL || 'claude-sonnet-4-6',
    openrouter: process.env.JUDGE_MODEL_OPENROUTER || 'anthropic/claude-sonnet-4.6',
  },
  // MM: the media agent, USER-FACING. Convo (text-only) delegates any non-text file the user texts —
  // photo/video/voice memo/PDF/document — here; MM ingests media NATIVELY (default Gemini flash) and
  // voices Irises's reply ITSELF as a {could_not_open, analysis, bubbles} JSON envelope (no composer
  // hop) — one pass, no tools. The `anthropic` slug is the cross-provider fallback for image and
  // document turns (allowDocumentFallback opts in); audio/video turns never fall back (Anthropic has
  // no native audio/video; see hasNativeMedia in callLLM). Must be structured-outputs-capable
  // (jsonBubbles envelope) — same rule as Convo's fallback slug (see convo entry above).
  // Role id and persona folder are both `mm` (src/agents/mm/Context.md).
  mm: {
    anthropic: process.env.MM_MODEL || 'claude-sonnet-5',
    openrouter: process.env.MM_MODEL_OPENROUTER || 'google/gemini-3.5-flash',
  },
  // Fallfirm: the fallback+confirm voicer. When a primary agent couldn't voice a failure or a
  // confirmation itself (Convo is single-shot and never sees a tool result; or the composer/autonome/
  // judge model call failed), Fallfirm re-voices the outcome in Irises's tone, seamlessly continuing
  // the thread — so the user never sees hardcoded dev copy. Haiku-tier like Convo/Composer: it only
  // transforms a known outcome into voice, no reasoning.
  fallfirm: {
    anthropic: process.env.FALLFIRM_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.FALLFIRM_MODEL_OPENROUTER || 'anthropic/claude-haiku-4.5',
  },
  // Reflexion: the memory curator (daily reflection at local midnight, Convo-delegated memory
  // updates, conservative self-wakes). Curation errors are permanent and compounding, so this
  // role deliberately runs the strongest tier at xhigh effort — the same model on BOTH lanes:
  // the role is about the reasoning tier, not lane diversity. Fully silent (never voices).
  reflexion: {
    anthropic: process.env.REFLEXION_MODEL || 'claude-opus-4-8',
    openrouter: process.env.REFLEXION_MODEL_OPENROUTER || 'anthropic/claude-opus-4.8',
  },
  // Reflexion-Delegated: the SAME curator, but on the Convo `update_memory` path — a user explicitly
  // asked Irises to remember/adjust something on the LIVE turn, rather than the silent daily/self-wake
  // passes. That is a narrower, well-scoped write, so it can run a lighter/cheaper tier than the daily
  // reflection. Every knob INHERITS the base REFLEXION_* value when its own REFLEXION_DELEGATED_*
  // override is unset, so an untouched deploy behaves exactly like `reflexion`.
  reflexion_delegated: {
    anthropic: process.env.REFLEXION_DELEGATED_MODEL || process.env.REFLEXION_MODEL || 'claude-opus-4-8',
    openrouter: process.env.REFLEXION_DELEGATED_MODEL_OPENROUTER || process.env.REFLEXION_MODEL_OPENROUTER || 'anthropic/claude-opus-4.8',
  },
};

export const MAX_TOKENS: Record<LlmRole, number> = {
  // Voicer ceilings are deliberately HIGH and non-binding. On OpenRouter, reasoning models
  // (deepseek-v4-flash) spend chain-of-thought tokens AGAINST max_tokens before any content —
  // a "right-sized" budget (the old 512/2560) got fully eaten by reasoning (finish_reason=length,
  // content=null) and the reply degraded to Fallfirm. Output only costs what's generated, so these
  // are runaway backstops, not tuning knobs. classify keeps a tiny cap ON PURPOSE:
  // it's an output constraint (one word), not a budget.
  // Convo can arm reasoning (CONVO_EFFORT), which spends CoT against this ceiling — so it's raised to
  // a non-binding 64000 (env CONVO_MAX_TOKENS) so xhigh reasoning + the reply can NEVER starve. 64000
  // is safe ONLY because the Anthropic lane STREAMS (callLLM's messages.stream().finalMessage()):
  // the SDK rejects non-streaming requests above ~21,333 max_tokens (10-min guard), and that error is
  // statusless — it silently reroutes the whole role to the OpenRouter fallback lane.
  // The deepseek OpenRouter primary caps far higher. A chat reply uses a sliver of it — it just
  // costs what's generated — so this imposes no real budget, only a runaway backstop.
  convo: Number(process.env.CONVO_MAX_TOKENS) || 64000,
  ops: Number(process.env.OPS_MAX_TOKENS) || 64000, // high, non-binding output ceiling: adaptive thinking + the ANSWER/SOURCE/FLAGS summary (env: OPS_MAX_TOKENS). Safe over the STREAMING Anthropic path only — non-streaming create() rejects >~21.3k (see the convo note above); if the path ever reverts, drop to ≤20000.
  ops_escalation: Number(process.env.OPS_ESCALATION_MAX_TOKENS) || Number(process.env.OPS_MAX_TOKENS) || 64000, // mirrors ops (env: OPS_ESCALATION_MAX_TOKENS, falls back to OPS_MAX_TOKENS)
  ops_mm: Number(process.env.OPS_MM_MAX_TOKENS) || 8192, // describes/transcribes one attachment — voicer-tier budget is plenty (env: OPS_MM_MAX_TOKENS)
  classify: Number(process.env.CLASSIFY_MAX_TOKENS) || 20, // one word BY DESIGN; only raise if you arm CLASSIFY_EFFORT/THINKING (env: CLASSIFY_MAX_TOKENS)
  autonome: Number(process.env.AUTONOME_MAX_TOKENS) || 8192, // raise if arming AUTONOME_EFFORT/THINKING (env: AUTONOME_MAX_TOKENS)
  judge: Number(process.env.JUDGE_MAX_TOKENS) || 1000, // structured verdict (tool call) + short voiced surfacing; RAISE if arming JUDGE_EFFORT/THINKING or it length-starves (env: JUDGE_MAX_TOKENS)
  mm: Number(process.env.MM_MAX_TOKENS) || 8192, // reads media + writes the {analysis, bubbles} envelope in one pass (env: MM_MAX_TOKENS)
  fallfirm: Number(process.env.FALLFIRM_MAX_TOKENS) || 8192, // raise if arming FALLFIRM_EFFORT/THINKING (env: FALLFIRM_MAX_TOKENS)
  reflexion: Number(process.env.REFLEXION_MAX_TOKENS) || 32000, // adaptive thinking + tool-loop writes; the long-doc rewrite is the largest single output (env: REFLEXION_MAX_TOKENS)
  reflexion_delegated: Number(process.env.REFLEXION_DELEGATED_MAX_TOKENS) || Number(process.env.REFLEXION_MAX_TOKENS) || 32000, // mirrors reflexion (env: REFLEXION_DELEGATED_MAX_TOKENS, falls back to REFLEXION_MAX_TOKENS)
};

// ── Per-role reasoning / caching / sampling tuning ──────────────────────────
// EVERY role reads its own <ROLE>_THINKING and <ROLE>_EFFORT from env (mirrors <ROLE>_MODEL /
// <ROLE>_MAX_TOKENS). The DEFAULTS below preserve prior behavior EXACTLY — only the Ops research tier,
// Ops-Escalation, and Reflexion (the memory curator) think + reason (xhigh) out of the box; every
// other role defaults OFF. So this is per-deploy opt-in: set e.g. JUDGE_EFFORT=high,
// AUTONOME_THINKING=on, or FALLFIRM_EFFORT=medium to dial those up without a code change. `effort` is
// applied via output_config.effort in callLLM INDEPENDENTLY of the jsonBubbles envelope, so it takes
// effect for tool-call roles (Judge) and plain voicers alike; null = don't send it.
// CAVEATS when you arm a role that defaults off:
//   • MODEL TIER: the Haiku-tier defaults (autonome/fallfirm/classify/ops_mm = Haiku 4.5; Judge = Sonnet
//     4.6) may REJECT output_config.effort on the Anthropic lane (Haiku 4.5 does). callLLM only auto-
//     degrades on a 400 for jsonBubbles roles — a plain role hard-errors. So arming effort on a Haiku
//     role usually means ALSO bumping <ROLE>_MODEL to a reasoning-capable slug (e.g. claude-sonnet-5).
//   • BUDGET: effort/thinking spend chain-of-thought tokens against max_tokens. The tight caps (Judge
//     1000, classify 20) WILL length-starve — raise the matching <ROLE>_MAX_TOKENS (now env-driven).
//   • OpenRouter caps effort at 'high' (toOpenRouterEffort maps xhigh/max down); effort also ARMS
//     reasoning on the OpenRouter lane (the THINKING||effort gate).
//   • thinking + temperature are mutually exclusive on Claude 4.x — callLLM drops temp when thinking is on.
// All knobs are overridable from deploy/app.env.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// `name` is the env var being parsed — used only in the warning, so an invalid OPS_ESCALATION_* value
// blames the right variable instead of always saying OPS_THINKING/OPS_EFFORT/OPS_TEMPERATURE.
function parseThinking(raw: string | undefined, fallback: boolean, name = 'OPS_THINKING'): boolean {
  const v = (raw || '').trim().toLowerCase();
  if (v === '') return fallback;
  if (['adaptive', 'on', 'true', '1', 'enabled', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'disabled', 'no'].includes(v)) return false;
  console.warn(`[llm] ${name}="${raw}" invalid — using ${fallback ? 'adaptive' : 'off'}`);
  return fallback;
}
function parseEffort(raw: string | undefined, fallback: EffortLevel | null, name = 'OPS_EFFORT'): EffortLevel | null {
  const v = (raw || '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'none' || v === 'off') return null;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) return v as EffortLevel;
  console.warn(`[llm] ${name}="${raw}" invalid — using ${fallback ?? 'none'}`);
  return fallback;
}
function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw || '').trim().toLowerCase();
  if (v === '') return fallback;
  return ['true', '1', 'on', 'yes'].includes(v);
}
function parseTemp(raw: string | undefined, fallback: number | null, name = 'OPS_TEMPERATURE'): number | null {
  const v = (raw || '').trim();
  if (v === '') return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  console.warn(`[llm] ${name}="${raw}" is not a number — ignoring`);
  return fallback;
}

/** Adaptive extended thinking, per role. Ops + Ops-Escalation (env: OPS_THINKING / OPS_ESCALATION_THINKING). */
export const THINKING: Record<LlmRole, boolean> = {
  convo: false,
  ops: parseThinking(process.env.OPS_THINKING, true),
  ops_escalation: parseThinking(process.env.OPS_ESCALATION_THINKING, true, 'OPS_ESCALATION_THINKING'),
  ops_mm: parseThinking(process.env.OPS_MM_THINKING, false, 'OPS_MM_THINKING'),
  classify: parseThinking(process.env.CLASSIFY_THINKING, false, 'CLASSIFY_THINKING'),
  autonome: parseThinking(process.env.AUTONOME_THINKING, false, 'AUTONOME_THINKING'),
  judge: parseThinking(process.env.JUDGE_THINKING, false, 'JUDGE_THINKING'),
  mm: parseThinking(process.env.MM_THINKING, false, 'MM_THINKING'),
  fallfirm: parseThinking(process.env.FALLFIRM_THINKING, false, 'FALLFIRM_THINKING'),
  reflexion: parseThinking(process.env.REFLEXION_THINKING, true, 'REFLEXION_THINKING'),
  reflexion_delegated: parseThinking(process.env.REFLEXION_DELEGATED_THINKING ?? process.env.REFLEXION_THINKING, true, 'REFLEXION_DELEGATED_THINKING'),
};
/** Reasoning effort, per role. Ops + Ops-Escalation (env: OPS_EFFORT / OPS_ESCALATION_EFFORT), plus
 *  the two user-facing voicers Convo + MM (env: CONVO_EFFORT / MM_EFFORT, default off). null = don't send. */
export const EFFORT: Record<LlmRole, EffortLevel | null> = {
  convo: parseEffort(process.env.CONVO_EFFORT, null, 'CONVO_EFFORT'),
  ops: parseEffort(process.env.OPS_EFFORT, 'xhigh'),
  ops_escalation: parseEffort(process.env.OPS_ESCALATION_EFFORT, 'xhigh', 'OPS_ESCALATION_EFFORT'),
  ops_mm: parseEffort(process.env.OPS_MM_EFFORT, null, 'OPS_MM_EFFORT'),
  classify: parseEffort(process.env.CLASSIFY_EFFORT, null, 'CLASSIFY_EFFORT'),
  autonome: parseEffort(process.env.AUTONOME_EFFORT, null, 'AUTONOME_EFFORT'),
  judge: parseEffort(process.env.JUDGE_EFFORT, null, 'JUDGE_EFFORT'),
  mm: parseEffort(process.env.MM_EFFORT, null, 'MM_EFFORT'),
  fallfirm: parseEffort(process.env.FALLFIRM_EFFORT, null, 'FALLFIRM_EFFORT'),
  reflexion: parseEffort(process.env.REFLEXION_EFFORT, 'xhigh', 'REFLEXION_EFFORT'),
  reflexion_delegated: parseEffort(process.env.REFLEXION_DELEGATED_EFFORT ?? process.env.REFLEXION_EFFORT, 'xhigh', 'REFLEXION_DELEGATED_EFFORT'),
};
/** Cache the large, stable system prefix, per role. Ops + Ops-Escalation (env: OPS_CACHE_SYSTEM / OPS_ESCALATION_CACHE_SYSTEM),
 *  plus Convo (env: CONVO_CACHE_SYSTEM, default on). Convo's large persona is byte-identical every turn and far over the
 *  4096-token cache floor, so caching it drops ~90% off the persona input WHENEVER Convo runs on the Anthropic lane — its
 *  transient-error fallback, and any deliberate CONVO_PROVIDER=anthropic flip. CRITICAL: Convo's system is
 *  `persona + PER-TURN sections` (current time to ms, dossier, …), so this flag ALONE is not enough — the cache
 *  breakpoint must sit AFTER the persona, which is why convo/client.ts passes LlmRequest.systemCachePrefixLen (see
 *  buildAnthropicSystem). Without that split the marker lands after the varying tail and every turn is a full cache WRITE
 *  (no reads, +25% premium) — do not remove the systemCachePrefixLen plumbing. Harmless no-op on the OpenRouter/deepseek
 *  primary lane: cache_control is an Anthropic-only feature non-Anthropic providers ignore. */
export const CACHE_SYSTEM: Record<LlmRole, boolean> = {
  convo: parseBoolEnv(process.env.CONVO_CACHE_SYSTEM, true), ops: parseBoolEnv(process.env.OPS_CACHE_SYSTEM, true),
  ops_escalation: parseBoolEnv(process.env.OPS_ESCALATION_CACHE_SYSTEM, true), ops_mm: false, classify: false,
  autonome: false, judge: false, mm: false, fallfirm: false,
  reflexion: parseBoolEnv(process.env.REFLEXION_CACHE_SYSTEM, true), // multi-step native loop re-sends the big prefix every step
  reflexion_delegated: parseBoolEnv(process.env.REFLEXION_DELEGATED_CACHE_SYSTEM ?? process.env.REFLEXION_CACHE_SYSTEM, true),
};
/** Sampling temperature, per role. Ops + Ops-Escalation (env: OPS_TEMPERATURE / OPS_ESCALATION_TEMPERATURE). null = don't send it.
 *  NOTE: temperature and extended thinking are mutually exclusive on Claude 4.x — the Anthropic path
 *  drops temperature when thinking is on (set OPS_THINKING=off to use it there). */
export const TEMPERATURE: Record<LlmRole, number | null> = {
  convo: null, ops: parseTemp(process.env.OPS_TEMPERATURE, null),
  ops_escalation: parseTemp(process.env.OPS_ESCALATION_TEMPERATURE, null, 'OPS_ESCALATION_TEMPERATURE'), ops_mm: null, classify: null,
  autonome: null, judge: null, mm: null, fallfirm: null,
  reflexion: parseTemp(process.env.REFLEXION_TEMPERATURE, null, 'REFLEXION_TEMPERATURE'),
  reflexion_delegated: parseTemp(process.env.REFLEXION_DELEGATED_TEMPERATURE ?? process.env.REFLEXION_TEMPERATURE, null, 'REFLEXION_DELEGATED_TEMPERATURE'),
};

// Per-role PRIMARY provider (<ROLE>_PROVIDER in .env). Defaults to Anthropic so existing
// deployments are unchanged. Set a role to `openrouter` to run it on an OpenRouter model
// (its <ROLE>_MODEL_OPENROUTER slug); Anthropic then becomes that role's fallback.
// NOTE: web search + PDF work on both providers (OpenRouter shaping in ./openrouterRequest), but
// on OpenRouter they need a TOOLS-CAPABLE model (supported_parameters includes "tools").
// A non-empty value that is neither provider is a typo — warn and default to anthropic
// rather than silently swallowing it.
function parseProvider(envName: string, fallback: LlmProvider = 'anthropic'): LlmProvider {
  const raw = process.env[envName];
  const v = (raw || '').trim().toLowerCase();
  if (v === 'openrouter') return 'openrouter';
  if (v === 'anthropic') return 'anthropic';
  if (v !== '') {
    console.warn(`[llm] ${envName}="${raw}" is not 'anthropic' or 'openrouter' — defaulting to ${fallback}`);
  }
  return fallback;
}

export const PROVIDERS: Record<LlmRole, LlmProvider> = {
  convo: parseProvider('CONVO_PROVIDER'),
  ops: parseProvider('OPS_PROVIDER'),
  // Escalation defaults to Anthropic even if OPS_ESCALATION_PROVIDER is unset — the whole point is a
  // different lane from the OpenRouter-primary Ops run that just failed.
  ops_escalation: parseProvider('OPS_ESCALATION_PROVIDER', 'anthropic'),
  classify: parseProvider('CLASSIFY_PROVIDER'),
  autonome: parseProvider('AUTONOME_PROVIDER'),
  judge: parseProvider('JUDGE_PROVIDER'),
  // MM's media route is OpenRouter-only (native audio/video), so default this role to openrouter
  // even if MM_PROVIDER is unset.
  mm: parseProvider('MM_PROVIDER', 'openrouter'),
  // Ops-MM (audio/video attachment reader) is native-media like mm: OpenRouter-only default.
  ops_mm: parseProvider('OPS_MM_PROVIDER', 'openrouter'),
  // Fallfirm: Anthropic primary like the other Haiku voicers, OpenRouter as transient fallback.
  fallfirm: parseProvider('FALLFIRM_PROVIDER'),
  // Reflexion defaults to Anthropic even in the OpenRouter-primary deployment — the second
  // deliberate exception besides the Judge/escalation lane: memory curation runs the strongest
  // first-party tier, and both slugs point at the same model anyway (tier over lane diversity).
  reflexion: parseProvider('REFLEXION_PROVIDER', 'anthropic'),
  // Inherits reflexion's primary lane when REFLEXION_DELEGATED_PROVIDER is unset; set it to pin the
  // delegated path to a different lane.
  reflexion_delegated: parseProvider('REFLEXION_DELEGATED_PROVIDER', parseProvider('REFLEXION_PROVIDER', 'anthropic')),
};

// ── Ops failure escalation (orchestration knobs; the model/provider live in the role above) ──
// When true, a failed Ops run can trigger ONE second look on the ops_escalation role. When false,
// triage still runs and records ops:triage events (shadow mode) but never spends a second run.
export const OPS_ESCALATION_ENABLED = parseBoolEnv(process.env.OPS_ESCALATION_ENABLED, true);
// Fresh deadline for the escalation leg (the first run already spent OPS_TASK_TIMEOUT_MS). Default 4m.
export const OPS_ESCALATION_TIMEOUT_MS = Number(process.env.OPS_ESCALATION_TIMEOUT_MS) || 4 * 60_000;
// When true, a TRANSIENT lane failure (llm_error / rate_limited) takes ONE cheap same-role retry on the
// primary ops model instead of the expensive escalation leg. callLLM already tries both providers per
// call, so this recovers a blip that has since cleared at a fraction of the escalation cost, with no
// document-parse engine swap. If the retry then returns a researchable miss, triage ladders it up to one
// escalation. When false, a transient error skips the retry and degrades straight to the transient-snag
// beat — it does NOT escalate (a stronger model can't fix an infra blip).
export const OPS_RETRY_ENABLED = parseBoolEnv(process.env.OPS_RETRY_ENABLED, true);

// Loud-but-harmless heads-up: a role pinned to OpenRouter with no key just falls back to
// Anthropic at call time, which can mask a config typo. Warn once at boot.
if (!process.env.OPENROUTER_API_KEY) {
  const orphaned = (Object.keys(PROVIDERS) as LlmRole[]).filter(r => PROVIDERS[r] === 'openrouter');
  if (orphaned.length) {
    console.warn(`[llm] ${orphaned.join(', ')} set to provider=openrouter but OPENROUTER_API_KEY is unset — these will fall back to Anthropic`);
  }
}

// Starvation trap, warned at boot: thinking/effort spend chain-of-thought AGAINST max_tokens on
// BOTH lanes, so a reasoning-armed role with a sub-1024 ceiling burns its whole budget before the
// first content token — the reply comes back cut off with nothing in it and the call throws
// (starvedError). This is the CLASSIFY_EFFORT=high + CLASSIFY_MAX_TOKENS=20 shape. NOTE: per-call
// req.maxTokens overrides bind over these ceilings and are invisible here — a clean ceiling does
// not prove the call sites are safe.
for (const role of Object.keys(MAX_TOKENS) as LlmRole[]) {
  if (!(THINKING[role] || EFFORT[role]) || MAX_TOKENS[role] >= 1024) continue;
  const env = role.toUpperCase();
  const armed = [THINKING[role] ? 'thinking' : null, EFFORT[role] ? `effort=${EFFORT[role]}` : null].filter(Boolean).join('+');
  console.warn(`[llm] ${role} arms reasoning (${armed}) with max_tokens=${MAX_TOKENS[role]} — it will length-starve: raise ${env}_MAX_TOKENS to 1024+ or disarm ${env}_EFFORT/${env}_THINKING`);
}
