// The one line that lifts the engine's read-only limit — and the four places that keep it narrow.
//
// Both doctrines forbid side effects outright ("never send email or post anywhere"). An approved
// action has to override that, for exactly itself and nothing else, so the authorization travels as
// ONE line in the brief and both doctrines name that line as the only thing that can lift the
// limit. A task nobody approved — every read task Irises has ever run — must produce a brief that
// is byte-identical to the one it produced before this line existed.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from './client.js';
import { HERMES_TASK_HEADER, HERMES_ONBOARDING_MESSAGE } from './hermesDoctrine.js';
import { OPENCLAW_TASK_HEADER, OPENCLAW_ONBOARDING_MESSAGE } from './openclawDoctrine.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

const AT = { now: Date.parse('2026-09-04T09:30:00Z'), tz: 'UTC' };
const ASK = 'email my landlord that rent is late';
const APPROVED_AT = Date.parse('2026-09-04T09:29:00Z');

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'general',
    request: ASK, effect: 'read', createdAt: AT.now, media: emptyMedia(), ...over,
  };
}

// ── the authorization line ───────────────────────────────────────────────────

test('an approved act task carries the AUTHORIZED ACTION line, right after the task kind', () => {
  const lines = buildTaskPrompt(
    mkTask({ effect: 'act', approval: { askedAt: APPROVED_AT - 60_000, approvedAt: APPROVED_AT } }),
    AT,
  ).split('\n');
  const kindAt = lines.findIndex(l => l.startsWith('task kind: '));
  assert.ok(kindAt >= 0);
  const line = lines[kindAt + 1];
  assert.ok(line.startsWith('AUTHORIZED ACTION: the user explicitly approved this exact action at '), line);
  assert.match(line, /Sep 4, 9:29 AM in UTC/, 'the clock is the moment they said yes, in their zone');
  assert.match(line, /: email my landlord that rent is late\./);
  assert.match(line, /You may perform it\./);
  assert.match(line, /Take no other side-effecting action/);
  assert.match(line, /if the action cannot be done exactly as stated, stop and report in ANSWER\./);
  assert.equal(lines.filter(l => l.startsWith('AUTHORIZED ACTION:')).length, 1, 'one authorization, not two');
});

test('nothing else authorizes anything: a read task, an unapproved act task, a bare approval ask', () => {
  const plain = buildTaskPrompt(mkTask(), AT);
  assert.doesNotMatch(plain, /AUTHORIZED ACTION/);
  // The brief for a read task is byte-identical to an act task nobody approved and to a task still
  // waiting on its answer — the line is keyed to the APPROVAL, not to the effect tag.
  assert.equal(buildTaskPrompt(mkTask({ effect: 'act' }), AT), plain);
  assert.equal(buildTaskPrompt(mkTask({ effect: 'act', approval: { askedAt: APPROVED_AT } }), AT), plain);
  // And an approval without the act tag is not an authorization either.
  assert.equal(buildTaskPrompt(mkTask({ approval: { askedAt: APPROVED_AT - 1, approvedAt: APPROVED_AT } }), AT), plain);
});

// ── the doctrines ────────────────────────────────────────────────────────────

test('both doctrines name the brief line as the only thing that lifts the read-only limit', () => {
  for (const [name, header, standing] of [
    ['hermes', HERMES_TASK_HEADER, HERMES_ONBOARDING_MESSAGE],
    ['openclaw', OPENCLAW_TASK_HEADER, OPENCLAW_ONBOARDING_MESSAGE],
  ] as const) {
    assert.match(header, /AUTHORIZED ACTION line in the brief, and only for that action/, `${name} task header`);
    assert.match(standing, /AUTHORIZED ACTION line/, `${name} standing section`);
    // The limit that is NEVER lifted, on either lane.
    assert.match(header, /NEVER message the user on any channel yourself/, `${name} header keeps the channel limit`);
    assert.match(standing, /never lifted/, `${name} standing section keeps the channel limit absolute`);
  }
});
