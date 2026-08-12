import { getLlmRoleStats } from '../db/repositories/tokenUsage.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { LlmRequest, LlmResult } from './types.js';

// Token budget guards — the circuit breakers a runaway spend incident exposes. Three layers:
//   (a) per-call:  refuse to SEND a request whose text alone is implausibly large
//   (b) per-task:  the Ops loop stops researching once a task has billed enough
//   (c) per-day:   a role-level kill switch backed by the token_usage ledger
// All layers are env-tuned and default to generous values (or off) so behavior only changes at
// pathological sizes. A tripped guard throws BudgetExceededError with nonFallbackable set — the
// fallback policy fails it LOUD instead of re-billing the other provider.

export class BudgetExceededError extends Error {
  readonly nonFallbackable = true;
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// ── (a) per-call estimated input ceiling ───────────────────────────────────

/** Estimated input tokens above which a single request is refused (default 150k ≈ 600k chars). */
export const LLM_MAX_INPUT_TOKENS_EST = Number(process.env.LLM_MAX_INPUT_TOKENS_EST || 150_000);

/**
 * chars/4 over the TEXT content only (system + string messages + text blocks). Media/document
 * base64 is deliberately exempt: base64 length wildly overestimates billed tokens for a parsed
 * PDF, and that lane is bounded by its own byte caps (attachments.ts) instead.
 */
export function estimateInputTokens(req: LlmRequest): number {
  let chars = req.system?.length ?? 0;
  for (const m of req.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const b of m.content) chars += b.type === 'text' ? b.text.length : 0;
  }
  return Math.ceil(chars / 4);
}

// ── (b) per-task cumulative billed-token budget ─────────────────────────────

/** Billed tokens (input+output, incl. cache) an Ops task may spend before it must wrap up. */
export const OPS_TASK_TOKEN_BUDGET = Number(process.env.OPS_TASK_TOKEN_BUDGET || 750_000);

/** Accumulates ACTUAL billed usage across a task's calls — the ground truth the per-call estimate
 *  can't see (server-side web search bills fetched pages as prompt tokens). */
export class TaskBudget {
  private spent = 0;
  constructor(private readonly maxTokens = OPS_TASK_TOKEN_BUDGET) {}
  add(usage?: LlmResult['usage']): void {
    if (!usage) return;
    this.spent += usage.inputTokens + usage.outputTokens
      + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  }
  exceeded(): boolean { return this.spent >= this.maxTokens; }
  spentTokens(): number { return this.spent; }
}

// Task-budget registry: the SINGLE accounting path for a task's spend. callLLM reports every
// successful call's usage against trace.taskId, so tool-INTERNAL calls (PDF extraction, attachment
// reads, message drafting — each its own callLLM under the same taskId) hit the same budget as the
// loop's own steps. Without this, only loop steps were metered and a tool-happy model could spend
// unbounded tokens through tools while the 750k breaker never tripped.
const taskBudgets = new Map<string, TaskBudget>();

export function registerTaskBudget(taskId: string, budget: TaskBudget): void {
  taskBudgets.set(taskId, budget);
}

/** Compare-and-delete: an abandoned (timed-out) leg's late cleanup must not evict the escalation
 *  leg's budget, which re-registers under the same task id. */
export function unregisterTaskBudget(taskId: string, budget: TaskBudget): void {
  if (taskBudgets.get(taskId) === budget) taskBudgets.delete(taskId);
}

/** Called by callLLM after every successful call. No-op for untracked tasks/roles. */
export function reportTaskUsage(taskId: string | undefined, usage?: LlmResult['usage']): void {
  if (!taskId || !usage) return;
  taskBudgets.get(taskId)?.add(usage);
}

// ── (c) daily per-role kill switch ──────────────────────────────────────────

/** Daily billed-token cap for the ops+ops_escalation roles combined. 0 = off. */
export const OPS_DAILY_TOKEN_CAP = Number(process.env.OPS_DAILY_TOKEN_CAP || 0);
/** Daily billed-token cap for the judge role alone. 0 = off. Judge runs per inbound email and can
 *  be pointed at a deep-research-class model, so it gets its own smoke alarm independent of the
 *  global cap (whose trip would kill every role). A tripped judge cap degrades that email to
 *  "not important" (judge/client.ts) — mail flow continues, only surfacing stops. */
export const JUDGE_DAILY_TOKEN_CAP = Number(process.env.JUDGE_DAILY_TOKEN_CAP || 0);
/** Daily billed-token cap across ALL roles. 0 = off. */
export const LLM_DAILY_TOKEN_CAP = Number(process.env.LLM_DAILY_TOKEN_CAP || 0);

const STATS_CACHE_MS = 5 * 60_000;
const OPS_ROLES = new Set(['ops', 'ops_escalation']);

interface DailySpend { ops: number; judge: number; total: number; fetchedAt: number; dayKey: string }
let cache: DailySpend | null = null;
let warnedDayKey: string | null = null;

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function fetchDailySpend(now: number, fetchStats: typeof getLlmRoleStats): Promise<DailySpend> {
  const midnight = Date.parse(`${utcDayKey(now)}T00:00:00Z`);
  const stats = await fetchStats(midnight).catch((err: unknown) => {
    // Fail-open is deliberate (see checkDailyBudget) but it was also SILENT, which made a wedged
    // ledger read indistinguishable from a day comfortably under budget — the one failure mode
    // that lets a runaway keep billing with every cap armed.
    reportError({
      source: 'budget', category: 'budget', severity: 'warn',
      message: 'daily spend read failed — token caps fail OPEN until the next fetch',
      err, detail: { since: new Date(midnight).toISOString(), cacheMs: STATS_CACHE_MS },
    });
    return [];
  });
  let ops = 0;
  let judge = 0;
  let total = 0;
  for (const s of stats) {
    total += s.totalTokens;
    if (OPS_ROLES.has(s.role)) ops += s.totalTokens;
    if (s.role === 'judge') judge += s.totalTokens;
  }
  return { ops, judge, total, fetchedAt: now, dayKey: utcDayKey(now) };
}

/** Test seam: reset the 5-minute cache between cases. */
export function resetDailySpendCache(): void { cache = null; warnedDayKey = null; }

/**
 * Throws BudgetExceededError when the role's day is spent. Ledger reads are cached 5 minutes, so
 * the cap can overshoot by one cache window — it's a smoke alarm, not an invoice. Fails OPEN
 * (no ledger → no data → no trip): availability over enforcement for a guard that defaults off.
 */
export async function checkDailyBudget(
  role: string,
  deps: { now?: () => number; fetchStats?: typeof getLlmRoleStats } = {},
): Promise<void> {
  if (!OPS_DAILY_TOKEN_CAP && !JUDGE_DAILY_TOKEN_CAP && !LLM_DAILY_TOKEN_CAP) return;
  const now = deps.now?.() ?? Date.now();
  if (!cache || now - cache.fetchedAt > STATS_CACHE_MS || cache.dayKey !== utcDayKey(now)) {
    cache = await fetchDailySpend(now, deps.fetchStats ?? getLlmRoleStats);
  }
  const nearing = (spent: number, cap: number) => cap > 0 && spent >= cap * 0.8 && spent < cap;
  if ((nearing(cache.ops, OPS_DAILY_TOKEN_CAP) || nearing(cache.judge, JUDGE_DAILY_TOKEN_CAP) || nearing(cache.total, LLM_DAILY_TOKEN_CAP)) && warnedDayKey !== cache.dayKey) {
    warnedDayKey = cache.dayKey;
    const line = `daily token spend at 80%+ of cap (ops=${cache.ops}/${OPS_DAILY_TOKEN_CAP || '∞'}, judge=${cache.judge}/${JUDGE_DAILY_TOKEN_CAP || '∞'}, total=${cache.total}/${LLM_DAILY_TOKEN_CAP || '∞'})`;
    console.warn(`[budget] ${line}`);
    // Once-per-day, sharing warnedDayKey with the console line above: the near-miss is the only
    // warning before a cap trip kills the role, so it needs to outlive the log buffer.
    reportError({
      source: 'budget', category: 'budget', severity: 'warn', message: line,
      detail: {
        ops: cache.ops, opsCap: OPS_DAILY_TOKEN_CAP || null,
        judge: cache.judge, judgeCap: JUDGE_DAILY_TOKEN_CAP || null,
        total: cache.total, totalCap: LLM_DAILY_TOKEN_CAP || null,
        dayKey: cache.dayKey,
      },
    });
  }
  if (LLM_DAILY_TOKEN_CAP > 0 && cache.total >= LLM_DAILY_TOKEN_CAP) {
    throw new BudgetExceededError(`daily global token cap exhausted (${cache.total}/${LLM_DAILY_TOKEN_CAP})`);
  }
  if (OPS_DAILY_TOKEN_CAP > 0 && OPS_ROLES.has(role) && cache.ops >= OPS_DAILY_TOKEN_CAP) {
    throw new BudgetExceededError(`daily ops token cap exhausted (${cache.ops}/${OPS_DAILY_TOKEN_CAP})`);
  }
  if (JUDGE_DAILY_TOKEN_CAP > 0 && role === 'judge' && cache.judge >= JUDGE_DAILY_TOKEN_CAP) {
    throw new BudgetExceededError(`daily judge token cap exhausted (${cache.judge}/${JUDGE_DAILY_TOKEN_CAP})`);
  }
}

// ── Rough $ estimation for the dashboard ────────────────────────────────────

// $/Mtok by model-name substring, first match wins. A smoke alarm, not an invoice — rates drift
// and providers discount; keep entries coarse. Cache reads are counted at 10% of input price.
const MODEL_PRICES: Array<{ match: RegExp; inPerM: number; outPerM: number }> = [
  // gpt-5.6 tiers, pro and non-pro sharing a unit price — the pro/deep-research cost shows up as
  // browsing VOLUME (real prompt tokens the ledger already counts), NOT a higher per-token rate.
  // A single "-pro at 15/120" entry was wrong and left the non-pro slugs falling through to
  // DEFAULT_PRICE.
  { match: /gpt-5\.6-luna(-pro)?/i, inPerM: 0.1, outPerM: 0.6 },
  { match: /gpt-5\.6-terra(-pro)?/i, inPerM: 1, outPerM: 6 },
  { match: /gpt-5\.6-sol(-pro)?/i, inPerM: 5, outPerM: 30 },
  { match: /opus/i, inPerM: 15, outPerM: 75 },
  { match: /sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /haiku/i, inPerM: 1, outPerM: 5 },
  { match: /deepseek/i, inPerM: 0.1, outPerM: 0.3 },
  { match: /gemini.*flash/i, inPerM: 0.3, outPerM: 1.2 },
];
const DEFAULT_PRICE = { inPerM: 3, outPerM: 15 };

export function estimateCostUsd(model: string, tokens: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): number {
  const price = MODEL_PRICES.find(p => p.match.test(model)) ?? DEFAULT_PRICE;
  return (tokens.inputTokens * price.inPerM
    + tokens.outputTokens * price.outPerM
    + (tokens.cacheReadTokens ?? 0) * price.inPerM * 0.1) / 1_000_000;
}

/** The per-call gate callLLM runs before dispatching any request. */
export async function checkCallBudgets(req: LlmRequest): Promise<void> {
  const est = estimateInputTokens(req);
  if (est > LLM_MAX_INPUT_TOKENS_EST) {
    throw new BudgetExceededError(`estimated input ${est} tokens exceeds per-call ceiling ${LLM_MAX_INPUT_TOKENS_EST} (role ${req.role})`);
  }
  await checkDailyBudget(req.role);
}
