// Run with: npm test   (TZ=UTC tsx --test)
// The Autonome runner's pre-fire dedupe: a due needsOps row whose EXACT research is already running
// live (a Convo delegation, or a lease-lapse re-claim of the same row) must NOT double-spend Ops —
// it's deferred, never voiced, and the row stays claimable. All LLM-free: the defer happens before
// prepareAutonomeJob, and the spy never runs the voicer thunk.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomeOnce } from './automations.js';
import { createAutomation } from '../db/repositories/automations.js';
import { markOpsStart, __resetOpsCoordination } from '../state/opsCoordination.js';
import { mem } from '../db/memory.js';
import type { Automation } from '../db/types.js';

let seq = 0;
function freshHandle(): string {
  return `+1555510${(seq++).toString().padStart(4, '0')}`;
}

function rowsFor(handle: string): Automation[] {
  return [...mem.automations.values()].filter(a => a.agentHandle === handle);
}

function makeSpy() {
  const calls: string[] = [];
  const sendFollowUp = async (chatId: string) => { calls.push(chatId); return 'sent'; };
  return { calls, sendFollowUp };
}

test('a due needsOps CRON row is deferred (not voiced) when identical research is already in flight', async () => {
  __resetOpsCoordination();
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'convo',
    title: 'weekly sweep', instruction: 'weekly roundup of local council notices',
    needsOps: true, opsKind: 'web_research',
    scheduleKind: 'cron', cron: '0 9 * * 1', timezone: 'America/Chicago',
    respectQuietHours: false, dedupeKey: 'dup:cron',
  });
  assert.ok(created);
  // Rewind so this tick claims it.
  mem.automations.set(created!.id, { ...mem.automations.get(created!.id)!, nextRunAt: new Date(Date.now() - 1000).toISOString() });
  // A live delegation of the SAME ask is running right now.
  markOpsStart(`chat-${h}`, 'live1', { kind: 'web_research', request: 'weekly roundup of local council notices' });

  const { calls, sendFollowUp } = makeSpy();
  await runAutonomeOnce(sendFollowUp);

  assert.deepEqual(calls, []);                       // never voiced — no double answer
  const after = rowsFor(h)[0];
  assert.equal(after.status, 'active');              // series stays alive
  assert.equal(after.claimedAt, null);               // lease released
  assert.equal(after.runCount, 0);                   // skipped occurrence never counts as a run
  assert.ok(Date.parse(after.nextRunAt) > Date.now(), 'deferred to the next cron occurrence');
});

test('a due needsOps ONCE row is deferred (re-armed, not retired) when identical research is in flight', async () => {
  __resetOpsCoordination();
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'convo',
    title: 'pull the numbers', instruction: 'pull the latest numbers on the transit bill',
    needsOps: true, opsKind: 'document_read',
    scheduleKind: 'once', nextRunAt: new Date(Date.now() - 1000).toISOString(),
    respectQuietHours: false, dedupeKey: 'dup:once',
  });
  assert.ok(created);
  markOpsStart(`chat-${h}`, 'live1', { kind: 'document_read', request: 'pull the latest numbers on the transit bill' });

  const { calls, sendFollowUp } = makeSpy();
  await runAutonomeOnce(sendFollowUp);

  assert.deepEqual(calls, []);                       // never voiced
  const after = rowsFor(h)[0];
  assert.equal(after.status, 'active');              // re-armed (NOT stuck 'done' from the atomic claim)
  assert.equal(after.claimedAt, null);
  assert.equal(after.runCount, 0);                   // the claim's +1 rolled back
  assert.ok(Date.parse(after.nextRunAt) > Date.now(), 'deferred into the near future so it fires once the live run settles');
});

test('the match is KIND-AGNOSTIC: an in-flight run under a different kind still defers the row', async () => {
  __resetOpsCoordination();
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'convo',
    title: 'permit status', instruction: 'check the permit status for the shack',
    needsOps: true, opsKind: 'web_research', // row keyed 'web_research'
    scheduleKind: 'cron', cron: '0 9 * * 1', timezone: 'America/Chicago',
    respectQuietHours: false, dedupeKey: 'dup:kind',
  });
  assert.ok(created);
  mem.automations.set(created!.id, { ...mem.automations.get(created!.id)!, nextRunAt: new Date(Date.now() - 1000).toISOString() });
  markOpsStart(`chat-${h}`, 'live1', { kind: 'document_read', request: 'check the permit status for the shack' }); // running as 'document_read'

  const { calls, sendFollowUp } = makeSpy();
  await runAutonomeOnce(sendFollowUp);

  assert.deepEqual(calls, []); // deferred despite the kind mismatch
  assert.equal(rowsFor(h)[0].status, 'active');
});

test('the guard is needsOps-scoped: a plain reminder with a matching in-flight ask still voices', async () => {
  __resetOpsCoordination();
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'convo',
    title: 'call the plumber', instruction: 'remind them to call the plumber',
    // needsOps omitted → false: nothing to double-spend, so the dedupe guard must not touch it.
    scheduleKind: 'once', nextRunAt: new Date(Date.now() - 1000).toISOString(),
    respectQuietHours: false, dedupeKey: 'dup:plain',
  });
  assert.ok(created);
  markOpsStart(`chat-${h}`, 'live1', { kind: 'web_research', request: 'remind them to call the plumber' });

  const { calls, sendFollowUp } = makeSpy();
  await runAutonomeOnce(sendFollowUp);

  assert.deepEqual(calls, [`chat-${h}`]); // a plain reminder is never gated by in-flight research
});
