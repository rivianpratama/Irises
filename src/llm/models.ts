import { isLaneConfigured, laneEnvVar } from './laneKeys.js';
import type { LlmRole, LlmProvider } from './types.js';

// Role -> the model slug on each provider. EVERY slot is overridable from .env so models
// can be tuned without code changes. Which provider runs FIRST for a role is set by
// PROVIDERS (below); the other provider is the automatic transient-error fallback.
// Confirm live slugs before shipping.
// Each role carries a slug per lane. `openai` is the generic OpenAI-compatible lane (env
// <ROLE>_MODEL_OPENAI): a bare provider-native id (no `vendor/` prefix, no `:nitro`/`:online`
// routing suffix — those are OpenRouter-only). Its default is a small, fast model so the chat voice
// stays cheap when a host points Irises's openai lane at OpenAI/Azure/etc.
export const MODELS: Record<LlmRole, { anthropic: string; openrouter: string; openai: string }> = {
  // Convo's Anthropic slot is the transient-error FALLBACK (OpenRouter/DeepSeek is primary). It
  // must be a structured-outputs-capable model (output_config.format carries the tool_calls
  // envelope) — Sonnet 4.6 is NOT (it would 400 into the unenforced path); Sonnet 5 is.
  convo: {
    anthropic: process.env.CONVO_MODEL || 'claude-sonnet-5',
    openrouter: process.env.CONVO_MODEL_OPENROUTER || 'deepseek/deepseek-v4-flash',
    openai: process.env.CONVO_MODEL_OPENAI || 'gpt-5.6-luna',
  },
  // Ops: deep work runs on the external engine (its own model), so nothing dispatches this role
  // natively today. The entry stays because `ops` is the role string the token ledger and daily
  // cost caps are keyed on (budget.ts / OPS_DAILY_TOKEN_CAP).
  ops: {
    anthropic: process.env.OPS_MODEL || 'claude-opus-4-8',
    openrouter: process.env.OPS_MODEL_OPENROUTER || 'anthropic/claude-opus-4.8',
    openai: process.env.OPS_MODEL_OPENAI || 'gpt-5.6-luna',
  },
  classify: {
    anthropic: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.CLASSIFY_MODEL_OPENROUTER || 'anthropic/claude-haiku-4.5',
    openai: process.env.CLASSIFY_MODEL_OPENAI || 'gpt-5.6-luna',
  },
  // Fallfirm: the fallback+confirm voicer. When a primary agent couldn't voice a failure or a
  // confirmation itself (Convo is single-shot and never sees a tool result; or the composer
  // model call failed), Fallfirm re-voices the outcome in Irises's tone, seamlessly continuing
  // the thread — so the user never sees hardcoded dev copy. Haiku-tier like Convo/Composer: it only
  // transforms a known outcome into voice, no reasoning.
  fallfirm: {
    anthropic: process.env.FALLFIRM_MODEL || 'claude-haiku-4-5',
    openrouter: process.env.FALLFIRM_MODEL_OPENROUTER || 'anthropic/claude-haiku-4.5',
    openai: process.env.FALLFIRM_MODEL_OPENAI || 'gpt-5.6-luna',
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
  ops: Number(process.env.OPS_MAX_TOKENS) || 64000, // not dispatched natively (engine-owned) — kept with the role
  classify: Number(process.env.CLASSIFY_MAX_TOKENS) || 20, // one word BY DESIGN; only raise if you arm CLASSIFY_EFFORT/THINKING (env: CLASSIFY_MAX_TOKENS)
  fallfirm: Number(process.env.FALLFIRM_MAX_TOKENS) || 8192, // raise if arming FALLFIRM_EFFORT/THINKING (env: FALLFIRM_MAX_TOKENS)
};

// ── Per-role reasoning / caching / sampling tuning ──────────────────────────
// EVERY role reads its own <ROLE>_THINKING and <ROLE>_EFFORT from env (mirrors <ROLE>_MODEL /
// <ROLE>_MAX_TOKENS). The DEFAULTS below preserve prior behavior EXACTLY — every voicer role
// defaults OFF. So this is per-deploy opt-in: set e.g. FALLFIRM_EFFORT=medium to dial a role up
// without a code change. `effort` is applied via output_config.effort in callLLM INDEPENDENTLY of
// the jsonBubbles envelope; null = don't send it.
// CAVEATS when you arm a role that defaults off:
//   • MODEL TIER: the Haiku-tier defaults (fallfirm/classify = Haiku 4.5) may REJECT
//     output_config.effort on the Anthropic lane (Haiku 4.5 does). callLLM only auto-degrades on a
//     400 for jsonBubbles roles — a plain role hard-errors. So arming effort on a Haiku role usually
//     means ALSO bumping <ROLE>_MODEL to a reasoning-capable slug (e.g. claude-sonnet-5).
//   • BUDGET: effort/thinking spend chain-of-thought tokens against max_tokens. The tight caps
//     (classify 20) WILL length-starve — raise the matching <ROLE>_MAX_TOKENS (now env-driven).
//   • OpenRouter caps effort at 'high' (toOpenRouterEffort maps xhigh/max down); effort also ARMS
//     reasoning on the OpenRouter lane (the THINKING||effort gate).
//   • thinking + temperature are mutually exclusive on Claude 4.x — callLLM drops temp when thinking is on.
// All knobs are overridable from deploy/app.env.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// `name` is the env var being parsed — used only in the warning, so an invalid value blames the
// right variable.
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

/** Adaptive extended thinking, per role (env: <ROLE>_THINKING). */
export const THINKING: Record<LlmRole, boolean> = {
  convo: false,
  ops: parseThinking(process.env.OPS_THINKING, true),
  classify: parseThinking(process.env.CLASSIFY_THINKING, false, 'CLASSIFY_THINKING'),
  fallfirm: parseThinking(process.env.FALLFIRM_THINKING, false, 'FALLFIRM_THINKING'),
};
/** Reasoning effort, per role (env: <ROLE>_EFFORT, default off for voicers). null = don't send. */
export const EFFORT: Record<LlmRole, EffortLevel | null> = {
  convo: parseEffort(process.env.CONVO_EFFORT, null, 'CONVO_EFFORT'),
  ops: parseEffort(process.env.OPS_EFFORT, 'xhigh'),
  classify: parseEffort(process.env.CLASSIFY_EFFORT, null, 'CLASSIFY_EFFORT'),
  fallfirm: parseEffort(process.env.FALLFIRM_EFFORT, null, 'FALLFIRM_EFFORT'),
};
/** Cache the large, stable system prefix, per role. Convo (env: CONVO_CACHE_SYSTEM, default on):
 *  its large persona is byte-identical every turn and far over the 4096-token cache floor, so
 *  caching it drops ~90% off the persona input WHENEVER Convo runs on the Anthropic lane — its
 *  transient-error fallback, and any deliberate CONVO_PROVIDER=anthropic flip. CRITICAL: Convo's
 *  system is `persona + PER-TURN sections` (current time to ms, dossier, …), so this flag ALONE is
 *  not enough — a cache breakpoint must sit AFTER the persona, which is why convo/client.ts passes
 *  LlmRequest.systemCacheBreakpoints (see buildAnthropicSystem). Without that split the marker lands
 *  after the varying tail and every turn is a full cache WRITE (no reads, +25% premium) — do not
 *  remove the systemCacheBreakpoints plumbing. Its second offset is the same argument for the tool
 *  docs and the craft pages behind the persona. Harmless no-op on the OpenRouter/deepseek primary
 *  lane: cache_control is an Anthropic-only feature non-Anthropic providers ignore. */
export const CACHE_SYSTEM: Record<LlmRole, boolean> = {
  convo: parseBoolEnv(process.env.CONVO_CACHE_SYSTEM, true),
  ops: parseBoolEnv(process.env.OPS_CACHE_SYSTEM, true),
  classify: false,
  fallfirm: false,
};
/** Sampling temperature, per role (env: <ROLE>_TEMPERATURE). null = don't send it.
 *  NOTE: temperature and extended thinking are mutually exclusive on Claude 4.x — the Anthropic path
 *  drops temperature when thinking is on. */
export const TEMPERATURE: Record<LlmRole, number | null> = {
  convo: null,
  ops: parseTemp(process.env.OPS_TEMPERATURE, null),
  classify: null,
  fallfirm: null,
};

// Per-role PRIMARY provider (<ROLE>_PROVIDER in .env). Defaults to Anthropic so existing
// deployments are unchanged. Set a role to `openrouter` to run it on an OpenRouter model
// (its <ROLE>_MODEL_OPENROUTER slug), or `openai` for the generic OpenAI-compatible lane
// (<ROLE>_MODEL_OPENAI + OPENAI_BASE_URL); a configured other lane becomes the fallback.
// NOTE: web search + PDF work on the openrouter and anthropic lanes (OpenRouter shaping in
// ./openrouterRequest); on OpenRouter they need a TOOLS-CAPABLE model (supported_parameters
// includes "tools"). The generic `openai` lane sends no OpenRouter-proprietary fields.
// A non-empty value that is no known provider is a typo — warn and default rather than silently
// swallowing it.
function parseProvider(envName: string, fallback: LlmProvider = 'anthropic'): LlmProvider {
  const raw = process.env[envName];
  const v = (raw || '').trim().toLowerCase();
  if (v === 'openrouter') return 'openrouter';
  if (v === 'anthropic') return 'anthropic';
  if (v === 'openai') return 'openai';
  if (v !== '') {
    console.warn(`[llm] ${envName}="${raw}" is not 'anthropic', 'openrouter', or 'openai' — defaulting to ${fallback}`);
  }
  return fallback;
}

export const PROVIDERS: Record<LlmRole, LlmProvider> = {
  convo: parseProvider('CONVO_PROVIDER'),
  ops: parseProvider('OPS_PROVIDER'),
  classify: parseProvider('CLASSIFY_PROVIDER'),
  // Fallfirm: Anthropic primary like the other Haiku voicers, OpenRouter as transient fallback.
  fallfirm: parseProvider('FALLFIRM_PROVIDER'),
};

// When true, a TRANSIENT lane failure (llm_error / rate_limited) on a delegated engine run takes ONE
// cheap same-role retry. A fresh attempt recovers a blip that has since cleared. If the retry also
// fails, the run degrades to the transient-snag beat — the single retry is the whole ladder.
export const OPS_RETRY_ENABLED = parseBoolEnv(process.env.OPS_RETRY_ENABLED, true);

/** The walled-URL browser hint (env: OPS_WALLED_URL_HINT). Default ON. Gates BOTH halves of the
 *  feature: the `tooling:` line buildTaskPrompt inserts when the ask carries a JavaScript/login-
 *  walled link and the engine has a browser, and the deterministic retry that fires when such a
 *  first pass still comes back empty-handed. Off → the task prompt's bytes are exactly what they
 *  were before the hint existed and triage takes today's route.
 *
 *  Read at CALL time (a function, not a module-load const like its sibling above) so the off path
 *  is exercisable from a test without re-importing this module. */
export function walledUrlHintEnabled(): boolean {
  return parseBoolEnv(process.env.OPS_WALLED_URL_HINT, true);
}

// Loud-but-harmless heads-up: a role pinned to a lane with no key just falls back to another
// configured lane at call time, which can mask a config typo. Warn once at boot, per lane. A key
// that is SET BUT BLANK counts as unset here (isLaneConfigured) — that is the exact shape this is for.
export const ALL_LANES: readonly LlmProvider[] = ['anthropic', 'openrouter', 'openai'];
for (const lane of ALL_LANES) {
  if (isLaneConfigured(lane)) continue;
  const orphaned = (Object.keys(PROVIDERS) as LlmRole[]).filter(r => PROVIDERS[r] === lane);
  if (!orphaned.length) continue;
  // With no other configured lane there is nothing to fall back TO: callLLM fails these roles fast
  // (naming the vars) rather than half-working, so don't promise a lane that isn't there.
  const otherConfigured = ALL_LANES.some(p => p !== lane && isLaneConfigured(p));
  console.warn(otherConfigured
    ? `[llm] ${orphaned.join(', ')} set to provider=${lane} but ${laneEnvVar(lane)} is unset — these will fall back to another configured lane`
    : `[llm] ${orphaned.join(', ')} set to provider=${lane} but ${laneEnvVar(lane)} is unset and no other lane is configured — these roles cannot call an LLM at all`);
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
