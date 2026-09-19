// The third defect: she could claim a part of the ask had been handed over when no task carried it,
// and a failed engine action could vanish between the engine and the user.
//
// Both halves are code-owned on purpose. The model is shown, as fact, exactly which actions are
// inside the running task — so "did you ask it to set the skill?" is answered from the status rather
// than from what it remembers promising. And the composer is told, when the task carried actions,
// that their outcome is part of the answer rather than the back-office it normally drops.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActiveOps, handleSteerResearch } from './shared.js';
import { engineActionRelay } from '../orchestrator.js';
import { steerReplayTaskFor } from '../ops/triage.js';
import { buildTaskPrompt } from '../ops/client.js';
import {
  __resetOpsCoordination, getActiveOps, getOpsEngineActions, markOpsStart, requestOpsSteer,
  type ActiveOps,
} from '../../state/opsCoordination.js';
import type { OpsTask } from '../types.js';

const SETUP = 'install the skill at the URL they gave';
const SECOND = 'install the CLI it needs';

function running(over: Partial<ActiveOps> = {}): ActiveOps {
  const now = Date.now();
  return { taskId: 't1', kind: 'general', request: 'what those APIs charge', startedAt: now - 40_000, firstStartedAt: now - 40_000, ...over };
}

function task(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'general',
    request: 'what those APIs charge', effect: 'read', createdAt: Date.now(), ...over,
  };
}

// ── what the model is shown about a running task ─────────────────────────────

test('the tracked actions ride the status line, so a claim can be checked against it', () => {
  const one = renderActiveOps([running({ engineActions: [SETUP] })]);
  assert.match(one, /— handed over with it: "install the skill at the URL they gave"/);
  const two = renderActiveOps([running({ engineActions: [SETUP, SECOND] })]);
  assert.match(two, /— handed over with it: "install the skill at the URL they gave"; "install the CLI it needs"/);
  // Queued runs carry it too — a task that has not started still has contents.
  assert.match(renderActiveOps([running({ lastMilestone: 'queued', engineActions: [SETUP] })]), /hasn't started yet \(waiting for a free slot\) — handed over with it: "install the skill/);
});

test('an ordinary look says nothing about handed-over actions at all', () => {
  assert.ok(!renderActiveOps([running()]).includes('handed over with it'));
});

test('the section states the rule the status line exists to serve', () => {
  const out = renderActiveOps([running({ engineActions: [SETUP] })]);
  assert.match(out, /Those lines are the whole of what was handed over/);
  assert.match(out, /never say a part of what they asked is being taken care of unless it is listed there/);
  // The principle, not a transcript of the incident.
  assert.ok(!/skill|monid|search API/i.test(out.split('Those lines are')[1]), 'the rule names no example');
});

test('both additions can sit on one line without displacing each other', () => {
  const out = renderActiveOps([running({ steers: ['only the cheap tiers'], engineActions: [SETUP] })]);
  assert.match(out, /— you added: "only the cheap tiers" — handed over with it: "install the skill at the URL they gave"/);
});

// ── an addition that asks for something to be DONE ───────────────────────────
// The status block above calls those lines the whole of what was handed over, and a steer could not
// add to them: steer_research carried guidance only, and the replay leg folds that guidance into
// `request`, which renders inside the data tag the doctrines tell the engine to disregard. So a
// mid-run "also install X" was both invisible to the record and unactionable on the replay.

test('a steered action joins the tracked list, so the record stays the whole handover', () => {
  __resetOpsCoordination();
  markOpsStart('chatS', 'tS', { kind: 'general', request: 'what those APIs charge', engineActions: [SETUP] });
  requestOpsSteer('chatS', 'tS', 'also get the CLI in', [SECOND]);
  assert.deepEqual(getOpsEngineActions('chatS', 'tS'), [SETUP, SECOND]);
  assert.match(renderActiveOps(getActiveOps('chatS')), /handed over with it: "install the skill at the URL they gave"; "install the CLI it needs"/);
});

test('a steered action that would touch the user is never filed as one', () => {
  __resetOpsCoordination();
  markOpsStart('chatT', 'tT', { kind: 'general', request: 'cheapest flight thursday' });
  // Through the handler, because that is where the screen lives: the approval gate never sees a
  // steer, and the run is already going, so there is nothing to park — the entry is simply refused
  // the mandate while the words still ride along as an ordinary addition.
  handleSteerResearch('', 'and book it', 'chatT', '+15551234567', null, ['book it on their account']);
  // The addition is still remembered as something they said — it just buys no mandate.
  assert.equal(getOpsEngineActions('chatT', 'tT').length, 0);
  assert.deepEqual(getActiveOps('chatT')[0].steers, ['and book it']);
});

test('the replay leg carries the steered actions in the instruction layer', () => {
  const replay = steerReplayTaskFor(task({ engineActions: [SETUP] }), 'also get the CLI in', [SETUP, SECOND]);
  assert.deepEqual(replay.engineActions, [SETUP, SECOND]);
  const prompt = buildTaskPrompt(replay, { now: Date.parse('2026-09-19T09:30:00Z'), tz: 'UTC' });
  assert.ok(prompt.indexOf(SECOND) < prompt.indexOf('<user_request>'), 'above the data tag, as an instruction');
  // And the leg marker rides with it, because a replay follows a leg that already ran.
  assert.match(prompt, /A leg of this task has already run/);
});

test('a replay given no actions is exactly the task it always was', () => {
  const before = steerReplayTaskFor(task(), 'narrow it to jakarta');
  assert.equal(before.engineActions, undefined);
  assert.deepEqual(steerReplayTaskFor(task(), 'narrow it to jakarta', []), before);
});

// ── what the composer is told when the answer comes back ─────────────────────

test('on an answer, the outcome of each action is part of the answer and a failure is said plainly', () => {
  const clause = engineActionRelay(task({ engineActions: [SETUP, SECOND] }), 'answer');
  assert.match(clause, /2 things/);
  assert.match(clause, /part of their answer, not back-office/);
  assert.match(clause, /say so plainly and say what stopped it/);
  assert.match(clause, /never let one go unmentioned/);
  // Fidelity: the composer still may not invent an outcome the engine did not report.
  assert.match(clause, /never claim more than what came back says happened/);
});

test('on a miss or a snag, the clause forbids implying the actions were done', () => {
  for (const moment of ['miss', 'transient', 'needs_info'] as const) {
    const clause = engineActionRelay(task({ engineActions: [SETUP] }), moment);
    assert.match(clause, /nothing came back saying they were done/);
    assert.match(clause, /never word this as if they were/);
  }
});

test('a task that carried no actions adds nothing to any moment', () => {
  for (const moment of ['answer', 'miss', 'transient', 'needs_info'] as const) {
    assert.equal(engineActionRelay(task(), moment), '');
    assert.equal(engineActionRelay(task({ engineActions: [] }), moment), '');
  }
});
