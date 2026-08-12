// Exercises listFailedAutomations (backs the outreach_failures tool) and pins the read/write
// asymmetry it fixes: listAutomations structurally hides failed rows. In-memory backend.
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAutomations, listFailedAutomations } from '../db/repositories/automations.js';
import { renderScheduledOutreach, renderOutreachFailures } from '../agents/ops/tools.js';
import { mem } from '../db/memory.js';
import type { Automation, AutomationStatus, AutomationSource } from '../db/types.js';

const H = '+15550002222';

function auto(over: Partial<Automation> & { id: string; status: AutomationStatus }): Automation {
  return {
    agentHandle: H, chatId: 'c1', source: 'ops' as AutomationSource, title: null,
    instruction: 'nudge about the deadline', needsOps: false, opsKind: null, dealId: null,
    deadlineId: null, scheduleKind: 'once', nextRunAt: '2026-08-10T00:00:00Z', cron: null,
    timezone: 'America/Chicago', respectQuietHours: false, lastRunAt: null, runCount: 0,
    attempts: 0, lastError: null, claimedAt: null, dedupeKey: null, ...over,
  };
}

test('listFailedAutomations surfaces failed + still-retrying rows, hiding healthy and reflexion', async () => {
  mem.automations.clear();
  mem.automations.set('a1', auto({ id: 'a1', status: 'failed', lastError: 'send rejected by the gateway' }));
  mem.automations.set('a2', auto({ id: 'a2', status: 'active', attempts: 2, lastError: 'timeout' })); // mid-retry
  mem.automations.set('a3', auto({ id: 'a3', status: 'active', attempts: 0 }));                        // healthy → excluded
  mem.automations.set('a4', auto({ id: 'a4', status: 'failed', source: 'reflexion' }));                // internal → excluded

  const failed = await listFailedAutomations(H);
  assert.deepEqual(failed.map(f => f.id).sort(), ['a1', 'a2'],
    'only failed + retrying user-facing rows; healthy and reflexion are out');
});

test('listFailedAutomations is agent-scoped and orders newest last-attempt first', async () => {
  mem.automations.clear();
  mem.automations.set('a1', auto({ id: 'a1', status: 'failed', lastRunAt: '2026-08-01T00:00:00Z' }));
  mem.automations.set('a2', auto({ id: 'a2', status: 'failed', lastRunAt: '2026-08-09T00:00:00Z' }));
  mem.automations.set('b1', auto({ id: 'b1', status: 'failed', agentHandle: '+15550009999' }));

  const failed = await listFailedAutomations(H);
  assert.deepEqual(failed.map(f => f.id), ['a2', 'a1'], 'newest attempt first, other agents never leak');
});

test('listAutomations (the queue read) still hides failed rows — the gap outreach_failures fills', async () => {
  mem.automations.clear();
  mem.automations.set('a1', auto({ id: 'a1', status: 'active' }));
  mem.automations.set('a2', auto({ id: 'a2', status: 'paused' }));
  mem.automations.set('a3', auto({ id: 'a3', status: 'failed', lastError: 'boom' }));

  const queue = await listAutomations(H);
  assert.deepEqual(queue.map(a => a.id).sort(), ['a1', 'a2'],
    'a silently-failed send is invisible to the queue read — exactly why the reliability tool is needed');
});

test('renderOutreachFailures names the state, the last attempt and the error (and is honest when empty)', () => {
  assert.match(renderOutreachFailures([]), /healthy/);
  const out = renderOutreachFailures([
    auto({ id: 'a1', status: 'failed', title: 'ping about the renewal', lastRunAt: '2026-08-09T00:00:00Z', lastError: 'send rejected' }),
    auto({ id: 'a2', status: 'active', attempts: 2 }),
  ]);
  assert.match(out, /ping about the renewal/);
  assert.match(out, /GAVE UP \(failed\)/);
  assert.match(out, /last tried 2026-08-09/);
  assert.match(out, /send rejected/);
  assert.match(out, /retrying \(2 failed attempt\(s\)\)/);
  assert.match(out, /did NOT reach the user/);
});

test('renderScheduledOutreach distinguishes one-time from recurring and flags paused', () => {
  assert.match(renderScheduledOutreach([]), /no proactive follow-ups/);
  const NOW = Date.parse('2026-08-08T12:00:00Z');
  const out = renderScheduledOutreach([
    auto({ id: 'a1', status: 'active', title: 'renewal nudge', nextRunAt: '2026-08-10T00:00:00Z' }),
    auto({ id: 'a2', status: 'paused', title: 'weekly sweep', scheduleKind: 'cron', cron: '0 9 * * 1' }),
    auto({ id: 'a3', status: 'active', title: 'already fired twice', runCount: 2 }),
  ], NOW, 'UTC');
  assert.match(out, /once on 2026-08-10/);
  assert.match(out, /recurring \(cron 0 9 \* \* 1, America\/Chicago\)/);
  assert.match(out, /\[PAUSED\]/);
  assert.match(out, /fired 2x/);
  assert.match(out, /Read-only/);
});
