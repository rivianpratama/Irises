// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The LLM call ledger on SQLite: recorded rows round-trip, the role/hourly
// aggregates match the old Postgres RPC semantics (incl. nearest-rank p95), and
// — the reason this table exists — real rows now trip the daily budget caps
// WITHOUT an injected fetchStats (the wiring that used to fail open on the
// memory backend).
process.env.OPS_DAILY_TOKEN_CAP = '1000';
process.env.LLM_DAILY_TOKEN_CAP = '5000';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordTokenUsage, getLlmRoleStats, getLlmHourly, listUsageInWindow, listUsageForTasks, listSlowestCalls, listRecentErrors } from './tokenUsage.js';
import { resetStorageForTests } from '../sqlite.js';

beforeEach(() => resetStorageForTests());

const usage = (input: number, output = 0) => ({
  inputTokens: input, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
});

test('role stats aggregate calls/errors/fallbacks/tokens per (role, provider, model)', async () => {
  await recordTokenUsage({ role: 'convo', provider: 'anthropic', model: 'm1', usage: usage(100, 20), latencyMs: 50 });
  await recordTokenUsage({ role: 'convo', provider: 'anthropic', model: 'm1', usage: usage(200, 30), latencyMs: 150, fallbackFrom: 'openrouter' });
  await recordTokenUsage({ role: 'convo', provider: 'anthropic', model: 'm1', status: 'error', error: 'boom' });
  await recordTokenUsage({ role: 'ops', provider: 'openrouter', model: 'm2', usage: usage(500), latencyMs: 900 });

  const stats = await getLlmRoleStats(Date.now() - 60_000);
  assert.equal(stats.length, 2);
  const convo = stats.find(s => s.role === 'convo')!;
  assert.equal(convo.calls, 2);
  assert.equal(convo.errors, 1);
  assert.equal(convo.fallbacks, 1);
  assert.equal(convo.inputTokens, 300);
  assert.equal(convo.outputTokens, 50);
  assert.equal(convo.totalTokens, 350);
  assert.equal(convo.avgLatencyMs, 100);
  assert.equal(convo.p95LatencyMs, 150); // nearest-rank over [50, 150]
  const ops = stats.find(s => s.role === 'ops')!;
  assert.equal(ops.totalTokens, 500);
  // handle scoping
  await recordTokenUsage({ role: 'convo', provider: 'anthropic', model: 'm1', handle: 'sam', usage: usage(42) });
  const scoped = await getLlmRoleStats(Date.now() - 60_000, 'sam');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].totalTokens, 42);
});

test('hourly buckets floor to the hour and sum tokens', async () => {
  await recordTokenUsage({ role: 'convo', provider: 'anthropic', model: 'm', usage: usage(10), latencyMs: 10 });
  await recordTokenUsage({ role: 'ops', provider: 'anthropic', model: 'm', usage: usage(20), latencyMs: 30 });
  const buckets = await getLlmHourly(Date.now() - 60_000);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].bucket % 3_600_000, 0);
  assert.equal(buckets[0].calls, 2);
  assert.equal(buckets[0].totalTokens, 30);
});

test('window scoping: chat rows never leak into a handle-without-chat scope', async () => {
  await recordTokenUsage({ role: 'convo', provider: 'a', model: 'm', chatId: 'c1', handle: 'sam', usage: usage(1) });
  await recordTokenUsage({ role: 'judge', provider: 'a', model: 'm', handle: 'sam', usage: usage(2) }); // chat-less
  const now = Date.now();
  const byChat = await listUsageInWindow({ chatId: 'c1' }, now - 60_000, now + 1000);
  assert.deepEqual(byChat.map(r => r.inputTokens), [1]);
  const byHandle = await listUsageInWindow({ handle: 'sam' }, now - 60_000, now + 1000);
  assert.deepEqual(byHandle.map(r => r.inputTokens), [2]);
  assert.deepEqual(await listUsageInWindow({}, 0, now), []);
});

test('task attribution: listUsageForTasks matches exactly the given ids', async () => {
  await recordTokenUsage({ role: 'ops', provider: 'a', model: 'm', taskId: 't1', usage: usage(5) });
  await recordTokenUsage({ role: 'ops', provider: 'a', model: 'm', taskId: 't2', usage: usage(7) });
  await recordTokenUsage({ role: 'ops', provider: 'a', model: 'm', usage: usage(9) });
  const rows = await listUsageForTasks(['t1', 't2', 'missing']);
  assert.deepEqual(rows.map(r => r.inputTokens).sort(), [5, 7]);
  assert.deepEqual(await listUsageForTasks([]), []);
});

test('slowest + recent-error readers respect status and order', async () => {
  await recordTokenUsage({ role: 'convo', provider: 'a', model: 'm', usage: usage(1), latencyMs: 40 });
  await recordTokenUsage({ role: 'convo', provider: 'a', model: 'm', usage: usage(1), latencyMs: 4000 });
  await recordTokenUsage({ role: 'convo', provider: 'a', model: 'm', status: 'error', error: 'rate limited', latencyMs: 5 });
  const slow = await listSlowestCalls(Date.now() - 60_000, 5);
  assert.deepEqual(slow.map(c => c.latencyMs), [4000, 40]); // errors excluded
  const errs = await listRecentErrors(Date.now() - 60_000, 5);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'rate limited');
});

test('END-TO-END: real ledger rows trip the daily caps with NO injected fetchStats', async () => {
  const { checkDailyBudget, resetDailySpendCache, BudgetExceededError } = await import('../../llm/budget.js');
  resetDailySpendCache();
  // Under both caps: passes.
  await recordTokenUsage({ role: 'ops', provider: 'a', model: 'm', usage: usage(900) });
  await checkDailyBudget('ops');
  // Over the ops cap (1000): the ops role refuses, convo still runs (global 5000 not hit).
  resetDailySpendCache();
  await recordTokenUsage({ role: 'ops', provider: 'a', model: 'm', usage: usage(200) });
  await assert.rejects(checkDailyBudget('ops'), BudgetExceededError);
  await checkDailyBudget('convo');
  // Over the global cap: every role refuses.
  resetDailySpendCache();
  await recordTokenUsage({ role: 'convo', provider: 'a', model: 'm', usage: usage(4000) });
  await assert.rejects(checkDailyBudget('convo'), BudgetExceededError);
  await assert.rejects(checkDailyBudget('classify'), BudgetExceededError);
});
