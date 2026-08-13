import { Router, Request, Response } from 'express';
import { getLlmRoleStats, getLlmHourly, listSlowestCalls, listRecentErrors } from '../../../db/repositories/tokenUsage.js';
import { estimateCostUsd, OPS_DAILY_TOKEN_CAP, LLM_DAILY_TOKEN_CAP } from '../../../llm/budget.js';
import { driver } from '../../../db/client.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Today-UTC spend strip: per-role tokens + rough $ since UTC midnight, with the daily-cap
// budget guards' ceilings so the dashboard shows how close the kill switches are to tripping.
async function todaySpend() {
  const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const stats = await getLlmRoleStats(midnight);
  const byRole = new Map<string, { role: string; calls: number; totalTokens: number; estCostUsd: number }>();
  let totalTokens = 0;
  let estCostUsd = 0;
  let opsTokens = 0;
  for (const s of stats) {
    const cost = estimateCostUsd(s.model, { inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: s.cacheReadTokens });
    const agg = byRole.get(s.role) ?? { role: s.role, calls: 0, totalTokens: 0, estCostUsd: 0 };
    agg.calls += s.calls;
    agg.totalTokens += s.totalTokens;
    agg.estCostUsd += cost;
    byRole.set(s.role, agg);
    totalTokens += s.totalTokens;
    estCostUsd += cost;
    if (s.role === 'ops') opsTokens += s.totalTokens;
  }
  return {
    roles: [...byRole.values()].sort((a, b) => b.estCostUsd - a.estCostUsd),
    totalTokens,
    estCostUsd,
    opsTokens,
    caps: { ops: OPS_DAILY_TOKEN_CAP || null, global: LLM_DAILY_TOKEN_CAP || null },
  };
}

// OpenRouter credit runway. The out-of-credits 402 is deterministic and (for OpenRouter-primary
// roles) fails loud or degrades to the Anthropic fallback lane — surfacing the balance here turns
// that into a heads-up before it bites (see fallbackPolicy.ts). Failure-tolerant: null on any
// error or a missing key, so an OpenRouter API blip never 500s the dashboard.
const OPENROUTER_CREDITS_WARN_USD = Number(process.env.OPENROUTER_CREDITS_WARN_USD) || 5;
async function openrouterCredits(): Promise<{ totalCredits: number; totalUsage: number; remainingUsd: number; warnUsd: number } | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: { total_credits?: number; total_usage?: number } };
    const totalCredits = body.data?.total_credits ?? 0;
    const totalUsage = body.data?.total_usage ?? 0;
    return { totalCredits, totalUsage, remainingUsd: totalCredits - totalUsage, warnUsd: OPENROUTER_CREDITS_WARN_USD };
  } catch {
    return null;
  }
}

// LLM call analytics over the durable token_usage ledger.

const WINDOWS: Record<string, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '30d': 30 * 86400_000,
};

export function registerAnalyticsRoutes(router: Router): void {
  router.get('/dashboard/api/analytics', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const windowKey = WINDOWS[String(req.query.since ?? '')] ? String(req.query.since) : '24h';
      const handle = req.query.handle ? String(req.query.handle) : undefined;
      const since = Date.now() - WINDOWS[windowKey];
      const payload = await cached(`analytics:${windowKey}:${handle ?? ''}`, 15_000, async () => {
        // The credits fetch has its OWN longer TTL: the analytics payload rebuilds every 15s, but
        // hitting OpenRouter's API that often is wasteful (and the balance moves slowly).
        const [roleStats, hourly, slowest, errors, today, openrouter] = await Promise.all([
          getLlmRoleStats(since, handle),
          getLlmHourly(since),
          listSlowestCalls(since, 20),
          listRecentErrors(since, 20),
          todaySpend(),
          cached('openrouter-credits', 300_000, openrouterCredits),
        ]);
        // Attach a $ estimate to every row and call (tokens × model price; see estimateCostUsd).
        // A smoke alarm, not an invoice — the rate table is coarse and cache reads are billed at
        // 10% of input. Roles are sorted by cost so the biggest spenders surface at the top.
        const roleStatsWithCost = roleStats
          .map(s => ({ ...s, estCostUsd: estimateCostUsd(s.model, s) }))
          .sort((a, b) => b.estCostUsd - a.estCostUsd);
        const slowestWithCost = slowest.map(s => ({ ...s, estCostUsd: estimateCostUsd(s.model, s) }));
        const totals = roleStatsWithCost.reduce((acc, s) => ({
          calls: acc.calls + s.calls,
          errors: acc.errors + s.errors,
          fallbacks: acc.fallbacks + s.fallbacks,
          totalTokens: acc.totalTokens + s.totalTokens,
          inputTokens: acc.inputTokens + s.inputTokens,
          outputTokens: acc.outputTokens + s.outputTokens,
          estCostUsd: acc.estCostUsd + s.estCostUsd,
        }), { calls: 0, errors: 0, fallbacks: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 });
        const denom = totals.calls + totals.errors;
        return {
          since: windowKey,
          driver,
          roleStats: roleStatsWithCost,
          hourly,
          slowest: slowestWithCost,
          errors,
          today,
          openrouter,
          totals,
          fallbackRate: { calls: denom, fallbacks: totals.fallbacks, rate: denom ? totals.fallbacks / denom : 0 },
          errorRate: { calls: denom, errors: totals.errors, rate: denom ? totals.errors / denom : 0 },
        };
      });
      res.json(payload);
    } catch (err) {
      console.error('[dashboard] /api/analytics failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}
