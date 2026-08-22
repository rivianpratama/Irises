/**
 * Which provider lanes have credentials — the one place the LLM layer decides whether a lane is
 * usable AT ALL (as opposed to fallbackPolicy.ts, which decides whether a given error is worth
 * retrying on the other lane).
 *
 * The trap this module exists for is a key that is PRESENT BUT BLANK. `ANTHROPIC_API_KEY=` in .env
 * is the single-key setup — one OpenRouter key reused for everything — and it leaves the variable
 * SET, to an empty string. Both SDKs accept that happily: the Anthropic client constructs fine and
 * only throws from deep inside the first request ("Could not resolve authentication method.
 * Expected either apiKey or authToken to be set…"). So the layer's old assumption that Anthropic is
 * "always usable (required to boot)" made every primary-lane failure attempt a keyless fallback,
 * and the caller got that opaque SDK error INSTEAD of the primary lane's real one — a 400 that
 * Fallfirm and the floor could actually act on. Blank therefore means unconfigured, everywhere.
 */

import type { LlmProvider, LlmRole } from './types.js';

/** Env vars that can carry a lane's credential. Anthropic has two: the SDK takes an api key OR a
 *  bearer auth token and reads both from the environment, so either one configures the lane. The
 *  FIRST name is the one messages quote. */
const LANE_KEY_ENV: Record<LlmProvider, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/** The env var a lane's messages name. */
export function laneEnvVar(provider: LlmProvider): string {
  return LANE_KEY_ENV[provider][0];
}

/** A trimmed env value, or undefined when the variable is unset OR blank (`KEY=`, `KEY="   "`). */
export function envKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[name]?.trim();
  return v || undefined;
}

/** The credential to send for a lane (with the variable it came from), or undefined when the lane
 *  has none. Read at CALL time: .env edits between calls are honoured. */
export function laneKey(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env,
): { envVar: string; value: string } | undefined {
  for (const envVar of LANE_KEY_ENV[provider]) {
    const value = envKey(envVar, env);
    if (value) return { envVar, value };
  }
  return undefined;
}

/** Can this lane take a request at all? The gate on every lane decision: which client to build,
 *  and whether the fallback lane is even worth attempting. */
export function isLaneConfigured(provider: LlmProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return laneKey(provider, env) !== undefined;
}

/** One lane has no key. Thrown INSTEAD of dispatching to it — the SDKs' own auth errors arrive from
 *  deep inside a request and read as provider trouble rather than as the missing key they are.
 *  Statusless and NOT marked nonFallbackable on purpose: a keyless PRIMARY lane must still be
 *  salvaged by a configured fallback (shouldFallback treats statusless errors as retryable). */
export function laneUnconfiguredError(provider: LlmProvider): Error {
  return new Error(`${laneEnvVar(provider)} not configured (${provider} lane unavailable)`);
}

/** Neither lane has a key: the role cannot call an LLM at all. Names the role and BOTH vars,
 *  because "which key am I missing" is the only question the reader has. */
export function noLaneConfiguredError(role: LlmRole): Error {
  const vars = (Object.keys(LANE_KEY_ENV) as LlmProvider[]).map(laneEnvVar).join(' or ');
  return new Error(`${role}: no LLM lane is configured — set ${vars} (both are unset or blank)`);
}
