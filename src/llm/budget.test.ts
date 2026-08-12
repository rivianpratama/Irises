import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateInputTokens, estimateCostUsd, checkCallBudgets, checkDailyBudget, resetDailySpendCache,
  TaskBudget, BudgetExceededError, LLM_MAX_INPUT_TOKENS_EST,
  registerTaskBudget, unregisterTaskBudget, reportTaskUsage,
} from './budget.js';
import type { LlmRequest } from './types.js';

test('estimateInputTokens counts system + string messages + text blocks at chars/4', () => {
  const req: LlmRequest = {
    role: 'ops',
    system: 'a'.repeat(400),
    messages: [
      { role: 'user', content: 'b'.repeat(400) },
      { role: 'user', content: [{ type: 'text', text: 'c'.repeat(400) }] },
    ],
  };
  assert.equal(estimateInputTokens(req), 300);
});

test('estimateInputTokens exempts media/document base64 (bounded by byte caps, not this estimate)', () => {
  const req: LlmRequest = {
    role: 'ops',
    messages: [{
      role: 'user',
      content: [
        { type: 'document', mediaType: 'application/pdf', data: 'Q'.repeat(1_000_000) },
        { type: 'text', text: 'read this' },
      ],
    }],
  };
  assert.ok(estimateInputTokens(req) < 10, 'base64 payload must not count toward the text estimate');
});

test('checkCallBudgets throws a nonFallbackable BudgetExceededError above the per-call ceiling', async () => {
  const req: LlmRequest = {
    role: 'ops',
    messages: [{ role: 'user', content: 'x'.repeat((LLM_MAX_INPUT_TOKENS_EST + 1) * 4) }],
  };
  await assert.rejects(checkCallBudgets(req), (err: Error & { nonFallbackable?: boolean }) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.nonFallbackable, true);
    assert.match(err.message, /per-call ceiling/);
    return true;
  });
});

test('checkCallBudgets passes an ordinary request (daily caps default off)', async () => {
  await checkCallBudgets({ role: 'ops', messages: [{ role: 'user', content: 'find the answer' }] });
});

test('TaskBudget accumulates billed usage incl. cache tokens and trips at the cap', () => {
  const budget = new TaskBudget(1_000);
  assert.equal(budget.exceeded(), false);
  budget.add({ inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  budget.add(undefined); // a provider that returned no usage must not crash or count
  assert.equal(budget.exceeded(), false);
  budget.add({ inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 450, cacheCreationInputTokens: 50 });
  assert.equal(budget.spentTokens(), 1_000);
  assert.equal(budget.exceeded(), true);
});

test('task-budget registry: tool-internal usage reported under the taskId hits the same budget', () => {
  const budget = new TaskBudget(1_000);
  registerTaskBudget('task-1', budget);
  // A loop step and a tool-internal call (e.g. a PDF parse) both report under the task id.
  reportTaskUsage('task-1', { inputTokens: 400, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  reportTaskUsage('task-1', { inputTokens: 600, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  assert.equal(budget.exceeded(), true);
  reportTaskUsage('other-task', { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }); // unknown ids are a no-op
  unregisterTaskBudget('task-1', budget);
  reportTaskUsage('task-1', { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  assert.equal(budget.spentTokens(), 1_000, 'nothing lands after unregister');
});

test('unregister is compare-and-delete: an abandoned leg cannot evict the escalation leg budget', () => {
  const abandoned = new TaskBudget(1_000);
  registerTaskBudget('task-2', abandoned);
  const escalation = new TaskBudget(1_000);
  registerTaskBudget('task-2', escalation); // same task id, fresh leg
  unregisterTaskBudget('task-2', abandoned); // late cleanup from the abandoned leg
  reportTaskUsage('task-2', { inputTokens: 42, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  assert.equal(escalation.spentTokens(), 42, 'escalation budget still registered');
  unregisterTaskBudget('task-2', escalation);
});

test('estimateCostUsd prices each gpt-5.6 tier (pro and non-pro alike); sonnet stays below the pro rate', () => {
  const M = 1_000_000;
  const oneEach = { inputTokens: M, outputTokens: M };
  // luna 0.10/0.60 → $0.70, terra 1/6 → $7, sol 5/30 → $35; pro shares the unit price.
  assert.equal(estimateCostUsd('openai/gpt-5.6-luna', oneEach).toFixed(2), '0.70');
  assert.equal(estimateCostUsd('openai/gpt-5.6-luna-pro', oneEach).toFixed(2), '0.70');
  assert.equal(estimateCostUsd('openai/gpt-5.6-terra-pro', oneEach).toFixed(2), '7.00');
  assert.equal(estimateCostUsd('openai/gpt-5.6-sol', oneEach).toFixed(2), '35.00');
  // ordering guard: the gpt-5.6 entries sit ABOVE /opus//sonnet/, so a sonnet slug still hits 3/15.
  assert.equal(estimateCostUsd('claude-sonnet-4-6', oneEach).toFixed(2), '18.00');
});

test('checkDailyBudget is a no-op when both daily caps are off', async () => {
  resetDailySpendCache();
  let fetched = 0;
  await checkDailyBudget('ops', { fetchStats: async () => { fetched++; return []; } });
  assert.equal(fetched, 0, 'must not even read the ledger when disabled');
});
