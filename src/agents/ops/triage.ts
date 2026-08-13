// Ops failure triage.
//
// When a delegated engine run fails, the orchestrator asks this module WHY and WHAT TO DO. The
// reasoning is deterministic wherever the failure carries a machine-readable cause (timeout,
// needs_auth, cancelled, fidelity suppression, vision fetch fail); only a genuine empty miss needs
// one small LLM call to decide whether the ask has an information hole (only the user can fill it)
// or is simply unanswerable.
//
// Nothing here throws: every path degrades to `action: 'none'` (today's behavior — the generic miss
// steering question / transient snag line), so a triage bug can never block or crash a follow-up.

import { callLLM } from '../../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../../llm/promptTag.js';
import { OPS_RETRY_ENABLED } from '../../llm/models.js';
import type { OpsResult, OpsTask, OpsFailureCause } from '../types.js';

// What triage decides to do with a failed run:
//   retry     → cheap same-role second pass for a TRANSIENT lane blip (llm_error/rate_limited); no
//               model change, just a fresh attempt — callLLM re-tries both providers per call
//   ask_user  → the composer asks the user for a specific missing detail (the two-strike path)
//   give_up   → soft "couldn't get that" + adjacent offer; don't re-interrogate (no productive retry)
//   none      → today's behavior (the classifyResult moment stands: miss steering / transient snag)
export type TriageAction = 'retry' | 'ask_user' | 'give_up' | 'none';

export interface TriageDecision {
  cause: OpsFailureCause;
  action: TriageAction;
  missingFields?: string[];    // ask_user: the detail(s) only the user can supply
  deterministic: boolean;      // false when the empty-miss splitter (an LLM call) decided
}

/** A second leg has already run for this attempt (the cheap retry). Blocks a further RETRY
 *  (canRetry): at most one retry per attempt. */
export function isSecondLeg(task: OpsTask): boolean {
  return !!task.retryOf;
}

/** One cheap retry per attempt, for a transient lane blip (never a retry-of-retry). */
export function canRetry(task: OpsTask): boolean {
  return OPS_RETRY_ENABLED && !isSecondLeg(task);
}

/**
 * Deterministic failure classification from the result + the orchestrator's timeout flag. No LLM.
 */
export function detectCause(result: OpsResult, timedOut: boolean): OpsFailureCause {
  if (timedOut) return 'timeout';
  if (result.debrief?.failure?.cause === 'needs_auth') return 'needs_auth';
  const s = (result.summary ?? '').trim().toLowerCase();
  if (s === 'cancelled') return 'cancelled';
  const fail = result.debrief?.failure?.cause;
  if (fail === 'fidelity_suppressed') return 'fidelity_suppressed';
  if (fail === 'tool_errors') return 'tool_errors';
  if (fail === 'budget') return 'budget'; // must NOT read as llm_error (llm_error retries)
  if (result.status === 'rate_limited') return 'rate_limited';
  if (result.status === 'error') return 'llm_error';
  return 'empty_miss'; // status ok but classified as a miss, and not a fidelity suppression
}

/**
 * The decision matrix for a KNOWN (deterministic) cause. An empty miss is NOT decided here — the
 * orchestrator routes that to splitMiss() (the one LLM call) instead.
 */
export function decide(cause: OpsFailureCause, task: OpsTask): TriageDecision {
  const d = (action: TriageAction, extra: Partial<TriageDecision> = {}): TriageDecision =>
    ({ cause, action, deterministic: true, ...extra });

  switch (cause) {
    case 'needs_auth':   // engine rejected the API key — operator config; no retry helps
    case 'cancelled':    // user asked for silence
      return d('none');
    case 'budget':
      // Token budget exhausted. Soft "couldn't get that", no retry — the kill switch must never
      // light a bigger fire.
      return d('give_up');
    case 'llm_error':
    case 'rate_limited':
      // Transient LANE failures — the research PLAN was fine; the lane hiccuped and neither the
      // SDKs' own retries nor the cross-provider fallback recovered it. Take ONE cheap same-role
      // retry (a fresh attempt often clears it), else degrade to today's transient snag. canRetry
      // is false on a retry leg, so a SECOND transient error resolves to none.
      return canRetry(task) ? d('retry') : d('none');
    default:
      // Researchable failures (timeout / tool_errors / fidelity_suppressed) resolve to none — the
      // engine IS the strong model; there is no stronger second look to ladder up to.
      return d('none');
  }
}

// ── The one LLM call: split a genuine empty miss into info-hole / unanswerable / neither ──

function firstJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function cleanFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, 3)
    .map(s => s.trim().slice(0, 120));
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('triage timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Decide why an empty miss came back empty. One small `classify`-role call, bounded and defensive:
 * ANY failure (parse, timeout, throw) returns `action: 'none'` so the follow-up degrades to today's
 * generic steering question. `llm` is injectable for tests.
 */
export async function splitMiss(
  result: OpsResult,
  task: OpsTask,
  llm: typeof callLLM = callLLM,
): Promise<TriageDecision> {
  const cause: OpsFailureCause = 'empty_miss';
  const attempt = task.attempt ?? 1;
  const none: TriageDecision = { cause, action: 'none', deterministic: false };

  const ledger = (result.debrief?.toolsRun ?? [])
    .map(t => `${t.name}(${t.argsSummary}) -> ${t.ok ? 'ok' : 'FAILED'}: ${t.resultPreview}`)
    .join('\n') || '(no tools ran)';
  const digest = (result.debrief?.corpus ?? []).join('\n\n').slice(0, 2000) || '(the tools returned nothing)';

  const system = 'You are triaging a failed research task for a general assistant. A look ran but produced no usable answer. Decide WHY, choosing exactly one verdict. Reply with ONLY a JSON object, nothing else.';
  const user = `${wrapPrompt([
    dataTag('user_request', task.request),
    `the brief given to the researcher: ${task.metaPrompt ?? '(none)'}`,
    `task kind: ${task.kind}`,
    `tools it ran:\n${ledger}`,
    dataTag('tool_output_digest', digest),
  ].filter(Boolean).join('\n\n'))}

Choose ONE verdict:
- INFO_HOLE: the ask is under-specified — only the USER can supply the missing piece (which item/person, a date range, which document). The tools found nothing or ambiguous candidates because the target was not pinned down.
- RESEARCH_GAP: the ask was specific enough, but the research did not go deep enough or took the wrong route; a more thorough second pass could plausibly answer it.
- UNANSWERABLE: the answer is not reachable from the available tools/data, and neither clarification nor a deeper search would change that.

Reply with ONLY one JSON object:
{"verdict":"INFO_HOLE","missing":["short detail the user must supply","..."],"directive":""}
or {"verdict":"RESEARCH_GAP","missing":[],"directive":"one or two sentences: what to research further or differently"}
or {"verdict":"UNANSWERABLE","missing":[],"directive":""}`;

  let obj: Record<string, unknown> | null = null;
  try {
    const res = await withTimeout(
      llm({ role: 'classify', system, maxTokens: 500, messages: [{ role: 'user', content: user }], trace: { chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:triage' } }),
      15_000,
    );
    obj = firstJsonObject(res.text);
  } catch (err) {
    console.warn('[triage] splitMiss failed — degrading to today’s behavior', err);
    return none;
  }
  if (!obj) return none;

  const verdict = String(obj.verdict ?? '').toUpperCase();
  if (verdict === 'INFO_HOLE') {
    // Never re-interrogate on a second look: the user already answered one steering question.
    if (attempt >= 2) return { cause, action: 'give_up', deterministic: false };
    const missing = cleanFields(obj.missing);
    return missing.length
      ? { cause, action: 'ask_user', missingFields: missing, deterministic: false }
      : none; // no concrete field to ask for → fall back to the generic steering question
  }
  if (verdict === 'RESEARCH_GAP') {
    // The engine IS the strong model — there is no deeper second look to ladder up to, so a
    // research gap resolves to today's generic miss steering.
    return none;
  }
  if (verdict === 'UNANSWERABLE') {
    return { cause, action: 'give_up', deterministic: false };
  }
  return none;
}
