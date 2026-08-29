/**
 * Cross-provider fallback policy: when a primary-lane error may be salvaged by re-running the
 * request on the OTHER provider, vs when it must fail loud.
 *
 * The stakes are cost, not just correctness. The fallback lane can carry a completely different
 * billing profile (July 24: a dead Anthropic lane silently rerouted every Ops call to an
 * OpenRouter deep-research model at 100-880x the token bill). A deterministic error — a config
 * mistake, an SDK guard, an abort — re-fires on every call, so "fall back and hope" turns a loud
 * one-time failure into a permanent silent reroute. Only genuinely transient errors fall back.
 *
 * The one deterministic error we DO salvage is 402 (out of credits) — but only toward Anthropic,
 * never toward OpenRouter (see shouldFallback). It re-fires until the balance is topped up, so
 * rerouting toward OpenRouter would be exactly the July-24 silent-cost pattern; toward Anthropic
 * (first-party billing, hand-picked same-tier fallback slugs) it keeps Irises replying meanwhile.
 */

import type { LlmProvider } from './types.js';

/** Deterministic SDK/client guards that a retry cannot fix (they re-throw identically forever).
 *  The Anthropic SDK's non-streaming 10-minute guard is the canonical one: it is thrown
 *  client-side with NO status, so without this check it looks exactly like a network blip. */
const CONFIG_GUARD_PATTERNS = [/streaming is strongly recommended/i];

/** A 400/404 meaning the MODEL itself is unusable — a bad slug or a model no provider will serve —
 *  rather than a bad request body. A deploy config mistake (2026-08-01: `deepseek/deepseek-v4-flash-
 *  latest` shipped as a model id → "…is not a valid model ID"), so it re-fires on every call like a
 *  402; salvaging TOWARD Anthropic (valid first-party slug, first-party billing) keeps Irises replying
 *  through the misconfig instead of taking the role fully down. Covers ALL the OpenAI-compatible lanes
 *  (openrouter AND the generic openai lane), so an OpenAI/Azure/deepseek-direct typo self-heals the
 *  same way — the wordings differ per vendor. Kept deliberately narrow so ordinary validation 400s
 *  (schema/params) still fail loud. */
const MODEL_UNUSABLE = /not a valid model|no endpoints found|no allowed providers|does not exist or you do not have access|model[_ ]not[_ ]found|model not exist|the model `[^`]+` does not exist/i;

/** Errors marked by callers (budget guards) that must fail loud instead of re-billing elsewhere. */
export function isNonFallbackable(err: unknown): boolean {
  return (err as { nonFallbackable?: boolean })?.nonFallbackable === true;
}

/** Retryable = transient. 4xx auth/validation must fail loud (no silent double-billing).
 *  `fallbackLane` is the provider we WOULD retry on — it gates the directional exceptions (402,
 *  bad-model 400), which are safe only toward Anthropic. */
export function shouldFallback(err: unknown, fallbackLane: LlmProvider): boolean {
  // Caller-marked non-fallbackable (budget breakers) ALWAYS fail loud — checked before the status
  // branch so a nonFallbackable error that also carries a 429/5xx status can never be re-billed on
  // the other lane. (BudgetExceededError is statusless today; this is the ordering that keeps it so
  // if that ever changes.)
  if (isNonFallbackable(err)) return false;

  const message = String((err as Error)?.message ?? err);
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') {
    // 402 Payment Required = the account is out of credits (OpenRouter returns this when the
    // balance is exhausted). Deterministic — it re-fires on every call until credits are topped
    // up — so salvaging TOWARD OpenRouter would silently reroute a permanent failure onto a
    // billed lane (the July-24 pattern). Toward Anthropic it's safe: first-party billing, and
    // every OpenRouter-primary role has a hand-picked same-tier Anthropic fallback slug, so Irises
    // keeps replying while the OpenRouter balance is empty. The lane flip stays visible via the
    // llm:fallback trace event (dashboard fallback counters + orchestration graph).
    if (status === 402) return fallbackLane === 'anthropic';
    // A bad-model 400/404 (unusable slug / no-serving-provider / model-not-found) is likewise
    // deterministic and likewise salvageable ONLY toward Anthropic — same reasoning as 402. Toward
    // the OpenAI-compatible lanes it would just re-hit the same bad model, so it stays loud there.
    if ((status === 400 || status === 404) && fallbackLane === 'anthropic' && MODEL_UNUSABLE.test(message)) return true;
    return status >= 500 || status === 429;
  }

  // A cancelled request must not spawn a second billed call on the other provider. Abort errors
  // are shape-shifters: DOM aborts carry name 'AbortError', but Anthropic's APIUserAbortError never
  // sets .name (runtime name is 'Error'), so match the constructor and the SDKs' fixed messages
  // too. Belt only — callLLM's req.signal.aborted check is the authoritative guard.
  const name = (err as { name?: string })?.name ?? '';
  const ctor = (err as object)?.constructor?.name ?? '';
  if (name === 'AbortError' || name === 'APIUserAbortError' || ctor === 'APIUserAbortError') return false;
  if (/request was aborted|user aborted a request/i.test(message)) return false;

  if (CONFIG_GUARD_PATTERNS.some(p => p.test(message))) return false;

  // Network/connection errors (no status) are retryable.
  return true;
}
