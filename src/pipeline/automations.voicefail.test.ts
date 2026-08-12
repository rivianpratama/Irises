// Run with: npm test   (TZ=UTC tsx --test)
// What happens when a due automation's reach-out can NOT be voiced. Autonome no longer texts a
// Fallfirm apology for an automated run (no user expectation ⇒ silence beats a confusing
// "that update didn't come through") — it rejects, and the rejection rides through the mouth into
// the runner's catch. This pins the bookkeeping that makes such a miss durable instead of a log
// line: 'failed' for a one-time row, backoff-then-skip-the-occurrence for a cron series. Plus the
// pure fallbackText branch table. All LLM-free: the spy stands in for the mouth and never runs the
// voicer thunk.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomeOnce } from './automations.js';
import { nextRunAt } from './cron.js';
import { createAutomation, listFailedAutomations } from '../db/repositories/automations.js';
import { fallbackText } from '../agents/autonome/client.js';
import { mem } from '../db/memory.js';
import type { Automation, AutomationSource, ScheduleKind } from '../db/types.js';
import type { OpsResult, OpsStatus } from '../agents/types.js';

// Mondays 9am in the row's tz. The "skipped the occurrence" assertions recompute it with the SAME
// helper the runner uses, so they pin the branch taken rather than a wall-clock guess.
const CRON = '0 9 * * 1';
const CRON_TZ = 'America/Chicago';

let seq = 0;
function freshHandle(): string {
  return `+1555520${(seq++).toString().padStart(4, '0')}`;
}

function rowsFor(handle: string): Automation[] {
  return [...mem.automations.values()].filter(a => a.agentHandle === handle);
}

/**
 * Stands in for the mouth (state/mouth.ts sendFollowUp). Its contract is what this suite leans on:
 * it resolves once the voicer thunk produced text and the bubbles went out, and REJECTS when the
 * thunk threw (deliver() awaits the thunk, withDeadline re-rejects, the chat lock releases either
 * way). So `handed` is what the runner offered and `sent` is what actually reached the user.
 */
function makeMouth(opts: { fail?: boolean } = {}) {
  const handed: string[] = [];
  const sent: string[] = [];
  const sendFollowUp = async (chatId: string) => {
    handed.push(chatId);
    if (opts.fail) throw new Error('voicing failed');
    sent.push(chatId);
    return 'sent';
  };
  return { handed, sent, sendFollowUp };
}

/** Seed one due row. A cron row is created at its next FUTURE occurrence, so rewind it to claim now. */
async function seedDue(o: { handle: string; kind: ScheduleKind; title?: string; attempts?: number }): Promise<Automation> {
  const past = new Date(Date.now() - 1000).toISOString();
  const created = await createAutomation({
    agentHandle: o.handle, chatId: `chat-${o.handle}`, source: 'convo',
    title: o.title ?? 'call the dentist', instruction: 'remind them to call the dentist',
    // needsOps stays false: a plain reminder skips the in-flight dedupe gate AND the Ops leg, so
    // prepareAutonomeJob does nothing before the mouth gets the thunk — no LLM anywhere in here.
    scheduleKind: o.kind,
    ...(o.kind === 'cron' ? { cron: CRON } : { nextRunAt: past }),
    timezone: CRON_TZ, respectQuietHours: false, dedupeKey: `voicefail:${o.handle}`,
  });
  assert.ok(created, 'seed row created');
  mem.automations.set(created!.id, {
    ...mem.automations.get(created!.id)!,
    nextRunAt: past,
    ...(o.attempts != null ? { attempts: o.attempts } : {}),
  });
  return mem.automations.get(created!.id)!;
}

test('a ONCE row whose voicing fails is parked failed — the miss becomes visible, not silent', async () => {
  const h = freshHandle();
  const row = await seedDue({ handle: h, kind: 'once', title: 'quarterly review' });

  const mouth = makeMouth({ fail: true });
  await runAutonomeOnce(mouth.sendFollowUp);

  assert.deepEqual(mouth.handed, [`chat-${h}`]); // the runner did try
  assert.deepEqual(mouth.sent, []);              // ...and nothing reached the user
  const after = rowsFor(h)[0];
  assert.equal(after.status, 'failed');          // durable: the claim had retired it 'done'
  assert.equal(after.lastError, 'voicing failed');
  assert.equal(after.attempts, 1);
  assert.equal(after.claimedAt, null);           // lease released
  const failed = await listFailedAutomations(h);
  assert.deepEqual(failed.map(f => f.id), [row.id], 'outreach_failures can see it');
});

test('a CRON row whose voicing fails backs off and retries the SAME occurrence', async () => {
  const h = freshHandle();
  await seedDue({ handle: h, kind: 'cron' });

  const before = Date.now();
  const mouth = makeMouth({ fail: true });
  await runAutonomeOnce(mouth.sendFollowUp);

  assert.deepEqual(mouth.sent, []);
  const after = rowsFor(h)[0];
  assert.equal(after.status, 'active');   // series alive, and the row is claimable again
  assert.equal(after.attempts, 1);
  assert.equal(after.lastError, 'voicing failed');
  assert.equal(after.claimedAt, null);
  const delay = Date.parse(after.nextRunAt) - before;
  assert.ok(delay >= 60_000 && delay < 65_000, `first retry ~60s out (got ${delay}ms)`);
});

test('a CRON row out of retries skips the occurrence and resets the counter', async () => {
  const h = freshHandle();
  await seedDue({ handle: h, kind: 'cron', attempts: 3 }); // MAX_ATTEMPTS - 1

  const mouth = makeMouth({ fail: true });
  await runAutonomeOnce(mouth.sendFollowUp);

  const after = rowsFor(h)[0];
  assert.equal(after.status, 'active');
  // attempts back to 0 is the tell that this took the out-of-retries branch (the backoff branch
  // would have written 4): a bad day never carries its failure count into the next occurrence.
  assert.equal(after.attempts, 0);
  assert.equal(after.lastError, 'voicing failed'); // ...but the reason stays on the row
  assert.equal(after.nextRunAt, nextRunAt(CRON, CRON_TZ, new Date()), 'the next cron occurrence, not a backoff');
});

test('the success path is untouched: a once row completes clean, a cron row reschedules', async () => {
  const once = freshHandle();
  const cron = freshHandle();
  await seedDue({ handle: once, kind: 'once' });
  await seedDue({ handle: cron, kind: 'cron' });

  const mouth = makeMouth();
  await runAutonomeOnce(mouth.sendFollowUp);

  assert.deepEqual(mouth.sent.sort(), [`chat-${cron}`, `chat-${once}`].sort());
  const afterOnce = rowsFor(once)[0];
  assert.equal(afterOnce.status, 'done');
  assert.equal(afterOnce.lastError, null);
  assert.equal(afterOnce.attempts, 0);
  const afterCron = rowsFor(cron)[0];
  assert.equal(afterCron.status, 'active');
  assert.equal(afterCron.lastError, null);
  assert.equal(afterCron.attempts, 0);
  assert.equal(afterCron.nextRunAt, nextRunAt(CRON, CRON_TZ, new Date()));
});

// ── fallbackText: what may still be sent when the voicing model produced nothing ────────────────
function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1', agentHandle: '+15550001111', chatId: 'chat-1', source: 'convo' as AutomationSource,
    title: 'call the dentist', instruction: 'remind them to call the dentist at 9',
    needsOps: false, opsKind: null, dealId: null, deadlineId: null,
    scheduleKind: 'once', nextRunAt: '2026-08-10T00:00:00Z', cron: null, timezone: CRON_TZ,
    respectQuietHours: false, status: 'active', lastRunAt: null, runCount: 0, attempts: 0,
    lastError: null, claimedAt: null, dedupeKey: null, ...over,
  };
}

function result(status: OpsStatus, over: Partial<OpsResult> = {}): OpsResult {
  return { taskId: 't1', kind: 'general', status, summary: 'ANSWER: the meeting is thursday', ...over };
}

test('fallbackText echoes a plain reminder (the user\'s own words) with no model in the loop', () => {
  const a = auto();
  assert.equal(fallbackText(a, null), a.instruction);
});

test('fallbackText stays SILENT on every result-bearing branch — no Fallfirm for an automated run', () => {
  const a = auto();
  assert.equal(fallbackText(a, result('ok')), null);                  // Ops landed, voicing glitched
  assert.equal(fallbackText(a, result('error')), null);               // Ops failed
  assert.equal(fallbackText(a, result('not_found')), null);
  assert.equal(fallbackText(a, result('rate_limited')), null);
  // Even a mintable consent link is withheld: unannounced, an auth prompt out of nowhere is noise.
  assert.equal(fallbackText(a, result('needs_auth', { authUrl: 'https://example.test/consent' })), null);
});
