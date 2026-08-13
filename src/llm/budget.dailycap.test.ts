import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRoleStat } from '../db/repositories/tokenUsage.js';

// Daily caps are read at module load — set env BEFORE the dynamic import (each test file runs in
// its own process, so this doesn't leak into budget.test.ts, which asserts the caps-off default).
process.env.OPS_DAILY_TOKEN_CAP = '1000';
process.env.LLM_DAILY_TOKEN_CAP = '5000';

const stat = (role: string, totalTokens: number): LlmRoleStat => ({
  role, provider: 'anthropic', model: 'm', calls: 1, errors: 0, fallbacks: 0,
  avgLatencyMs: null, p95LatencyMs: null,
  inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens,
});

test('ops spend over the ops cap trips the ops role but not convo', async () => {
  const { checkDailyBudget, resetDailySpendCache, BudgetExceededError } = await import('./budget.js');
  resetDailySpendCache();
  const fetchStats = async () => [stat('ops', 1100), stat('convo', 100)];
  await assert.rejects(checkDailyBudget('ops', { fetchStats }), BudgetExceededError);
  await checkDailyBudget('convo', { fetchStats }); // global (1200) still under 5000
});

test('global cap trips every role', async () => {
  const { checkDailyBudget, resetDailySpendCache, BudgetExceededError } = await import('./budget.js');
  resetDailySpendCache();
  const fetchStats = async () => [stat('convo', 6000)];
  await assert.rejects(checkDailyBudget('convo', { fetchStats }), BudgetExceededError);
  await assert.rejects(checkDailyBudget('classify', { fetchStats }), BudgetExceededError);
});

test('ledger reads are cached ~5 minutes and refetched after expiry or a UTC day change', async () => {
  const { checkDailyBudget, resetDailySpendCache } = await import('./budget.js');
  resetDailySpendCache();
  let fetched = 0;
  const fetchStats = async () => { fetched++; return [stat('ops', 10)]; };
  let clock = Date.parse('2026-07-30T10:00:00Z');
  const now = () => clock;
  await checkDailyBudget('ops', { fetchStats, now });
  await checkDailyBudget('ops', { fetchStats, now });
  assert.equal(fetched, 1, 'second check within the window reuses the cache');
  clock += 6 * 60_000;
  await checkDailyBudget('ops', { fetchStats, now });
  assert.equal(fetched, 2, 'expired cache refetches');
  clock = Date.parse('2026-07-31T00:00:01Z');
  await checkDailyBudget('ops', { fetchStats, now });
  assert.equal(fetched, 3, 'new UTC day refetches (fresh spend bucket)');
});

test('a ledger failure fails OPEN (availability over enforcement)', async () => {
  const { checkDailyBudget, resetDailySpendCache } = await import('./budget.js');
  resetDailySpendCache();
  await checkDailyBudget('ops', { fetchStats: async () => { throw new Error('db down'); } });
});
