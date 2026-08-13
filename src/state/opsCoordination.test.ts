process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markOpsStart, markOpsDone, getActiveOps, isDuplicateDelegation,
  requestOpsCancel, isOpsCancelled, noteOpsProgress, hasInFlightRequest,
  normalizeRequest, __resetOpsCoordination, markOpsRetry, getOpsEtaStatus,
} from './opsCoordination.js';

test('markOpsStart is visible to a synchronous getActiveOps in the same tick (no async race)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'document_read', request: 'pull up that receipt' });
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'pull up that receipt');
  assert.equal(active[0].kind, 'document_read');
});

test('markOpsDone clears only the matching taskId; a concurrent distinct task survives', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  markOpsStart('chatA', 'task2', { kind: 'general', request: 'how did the launch go' });
  markOpsDone('chatA', 'task1');
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'how did the launch go');
});

test('isDuplicateDelegation reports in_flight for an identical (case/space-insensitive) running ask', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'Hours For The Corner Cafe' });
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for   the corner cafe'), 'in_flight');
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for the other place'), null);
});

test('after the task finishes it reports recent (not in_flight) within the window', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  markOpsDone('chatA', 'task1');
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for the corner cafe'), 'recent');
});

test('one chat never sees another chat\'s in-flight work', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  assert.equal(getActiveOps('chatB').length, 0);
  assert.equal(isDuplicateDelegation('chatB', 'web_research', 'hours for the corner cafe'), null);
});

test('normalizeRequest is case/whitespace-insensitive and scoped by kind', () => {
  assert.equal(normalizeRequest('general', '  Hello   World '), normalizeRequest('general', 'hello world'));
  assert.notEqual(normalizeRequest('general', 'x'), normalizeRequest('web_research', 'x'));
});

test('requestOpsCancel signals a running task: flag set, controller aborted, hidden from getActiveOps', () => {
  __resetOpsCoordination();
  const cancel = new AbortController();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' }, cancel);
  assert.equal(requestOpsCancel('chatA', 'task1'), 'signalled');
  assert.equal(isOpsCancelled('chatA', 'task1'), true);
  assert.equal(cancel.signal.aborted, true);
  assert.equal(getActiveOps('chatA').length, 0); // cancelled = no longer "still pulling"
});

test('requestOpsCancel on a finished/unknown task reports already_done', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' });
  markOpsDone('chatA', 'task1');
  assert.equal(requestOpsCancel('chatA', 'task1'), 'already_done');
  assert.equal(requestOpsCancel('chatA', 'never-existed'), 'already_done');
  assert.equal(isOpsCancelled('chatA', 'task1'), false);
});

test('a cancelled run neither blocks a re-ask as in_flight nor as recent', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' });
  assert.equal(isDuplicateDelegation('chatA', 'general', 'full inbox scan'), 'in_flight');
  requestOpsCancel('chatA', 'task1');
  // "actually, run it again" right after a cancel must start fresh.
  assert.equal(isDuplicateDelegation('chatA', 'general', 'full inbox scan'), null);
});

test('cancel is per-task: a concurrent distinct task keeps running', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' }, new AbortController());
  markOpsStart('chatA', 'task2', { kind: 'web_research', request: 'hours for the corner cafe' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'hours for the corner cafe');
  assert.equal(isOpsCancelled('chatA', 'task2'), false);
});

test('getActiveOps exposes taskId so the cancel handler can target entries', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task9', { kind: 'general', request: 'full inbox scan' });
  assert.equal(getActiveOps('chatA')[0].taskId, 'task9');
});

test('markOpsRetry keeps an in-flight task active + a duplicate through the second leg', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  // The retry resets the per-leg clock; the task stays active/visible so Convo keeps saying
  // "still on it" and dedupe suppression stays truthful through the second leg.
  markOpsRetry('chatA', 'task1');
  assert.equal(getActiveOps('chatA').length, 1);
  assert.equal(getActiveOps('chatA')[0].taskId, 'task1');
  assert.equal(isDuplicateDelegation('chatA', 'general', 'deep research'), 'in_flight');
});

test('origin is exposed via getActiveOps for scheduled runs; unset stays undefined (back-compat)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'user1', { kind: 'general', request: 'live ask' });
  markOpsStart('chatA', 'sched1', { kind: 'general', request: 'scheduled ask', origin: 'scheduled' });
  const byTask = Object.fromEntries(getActiveOps('chatA').map(o => [o.taskId, o]));
  assert.equal(byTask['user1'].origin, undefined);
  assert.equal(byTask['sched1'].origin, 'scheduled');
});

test('noteOpsProgress records the latest milestone; a later call overwrites', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  noteOpsProgress('chatA', 'task1', 'search_email');
  let active = getActiveOps('chatA')[0];
  assert.equal(active.lastMilestone, 'search_email');
  assert.equal(typeof active.milestoneAt, 'number');
  noteOpsProgress('chatA', 'task1', 'read_url');
  active = getActiveOps('chatA')[0];
  assert.equal(active.lastMilestone, 'read_url'); // most recent wins
});

test('noteOpsProgress is a no-op on a missing entry and on a cancelled entry', () => {
  __resetOpsCoordination();
  assert.doesNotThrow(() => noteOpsProgress('chatA', 'nope', 'read_email'));
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  // A late milestone from an abandoned/cancelled leg must not mutate or resurrect the entry.
  noteOpsProgress('chatA', 'task1', 'read_email');
  assert.equal(getActiveOps('chatA').length, 0); // still hidden (cancelled)
});

test('hasInFlightRequest matches case/whitespace-insensitively across a DIFFERENT kind', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'Hours For The Corner Cafe' });
  // The scheduler's row keyed this ask under 'general', but the running one is 'web_research' —
  // kind-agnostic match still fires.
  assert.equal(hasInFlightRequest('chatA', 'hours for   the corner cafe'), true);
  assert.equal(hasInFlightRequest('chatA', 'hours for the other place'), false);
});

test('hasInFlightRequest is chat-scoped and clears with the task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'weekly sweep' });
  assert.equal(hasInFlightRequest('chatB', 'weekly sweep'), false); // other chat never sees it
  markOpsDone('chatA', 'task1');
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), false); // gone after done
});

test('hasInFlightRequest ignores a cancelled run (a scheduled fire must not be blocked by it)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'weekly sweep' }, new AbortController());
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), true);
  requestOpsCancel('chatA', 'task1');
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), false);
});

test('a scheduled entry is cancellable like any other run', () => {
  __resetOpsCoordination();
  const cancel = new AbortController();
  markOpsStart('chatA', 'sched1', { kind: 'general', request: 'scheduled sweep', origin: 'scheduled' }, cancel);
  assert.equal(requestOpsCancel('chatA', 'sched1'), 'signalled');
  assert.equal(cancel.signal.aborted, true);
  assert.equal(getActiveOps('chatA').length, 0);
});

// ── ETA estimate tests ──────────────────────────────────────────────────────

test('markOpsStart stores an auto-computed estimate on the entry', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'draft', request: 'write a thank-you note' });
  const active = getActiveOps('chatA')[0];
  assert.equal(active.estimatePhrase, 'about a minute');
  assert.equal(active.estimateMs, 60_000);
});

test('markOpsStart accepts an explicit estimate and stores it', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'test', estimate: { bucketMs: 999, phrase: 'custom' } });
  const active = getActiveOps('chatA')[0];
  assert.equal(active.estimatePhrase, 'custom');
  assert.equal(active.estimateMs, 999);
});

test('markOpsRetry keeps the task alive but does NOT stretch the ETA', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  const before = getActiveOps('chatA')[0];
  markOpsRetry('chatA', 'task1');
  const after = getActiveOps('chatA')[0];
  assert.equal(after.firstStartedAt, before.firstStartedAt); // true elapsed still honest
  assert.equal(after.estimatePhrase, before.estimatePhrase); // never a different number
  assert.equal(isDuplicateDelegation('chatA', 'general', 'deep research'), 'in_flight');
});

test('markOpsRetry is a no-op on cancelled or missing entries', () => {
  __resetOpsCoordination();
  assert.doesNotThrow(() => markOpsRetry('chatA', 'nope'));
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'test' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  markOpsRetry('chatA', 'task1');
  assert.equal(isOpsCancelled('chatA', 'task1'), true);
  assert.equal(getActiveOps('chatA').length, 0);
});

test('getOpsEtaStatus returns a status for an active task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'something' });
  const status = getOpsEtaStatus('chatA', 'task1');
  assert.ok(status);
  assert.equal(status.state, 'early');
  assert.equal(typeof status.remainingPhrase, 'string');
});

test('getOpsEtaStatus returns undefined for a cancelled task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'something' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  assert.equal(getOpsEtaStatus('chatA', 'task1'), undefined);
});

test('getOpsEtaStatus returns undefined for a missing task', () => {
  __resetOpsCoordination();
  assert.equal(getOpsEtaStatus('chatA', 'nope'), undefined);
});
