// Convo-level coverage for reading reminders HONESTLY — the "action honesty" plan's first two
// tasks (.superpowers/sdd/task-1-brief.md, task-2-brief.md). Both defects live at the
// processConvoResult seam, not in the hermes adapter itself, so they need the full turn harness:
//
//   - list_automations on an empty list used to answer `nothing_found`, and every non-`confirmed`
//     outcome REPLACES whatever the model itself already said (see the correction block in
//     shared.ts) — so a model that honestly wrote "you don't have any reminders right now" got its
//     own true answer overwritten by a Fallfirm re-voicing of the identical fact.
//   - schedule_automation with no explicit timezone fell back straight to DEFAULT_TZ (the HOST's
//     zone), ignoring the zone this turn already resolved for the user (client.ts's `userTz`, now
//     threaded onto processConvoResult's args).
//
// Exercised end-to-end against processConvoResult with a stub engine (repo DI convention: no
// module mocks) — same harness composerParaphrase.test.ts and unkeptPromise.test.ts use. Later
// tasks (id-addressed reminder tools) add more tests to this file.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { resetEngineBackendCache, type EngineBackend, type ReminderRef, type ReminderSpec } from '../ops/engineBackend.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// Minimal engine stub (repo DI convention): serves canned reminders and captures createReminder
// specs so a test can assert what timezone actually reached the engine.
function installStubEngine(reminders: ReminderRef[] = []): { createdSpecs: ReminderSpec[] } {
  const createdSpecs: ReminderSpec[] = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder(spec) { createdSpecs.push(spec); return { id: 'r1', title: spec.title ?? spec.instruction, schedule: spec.cron ?? '' }; },
    async listReminders() { return reminders; },
    async cancelReminder() { return false; },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  resetEngineBackendCache(engine);
  return { createdSpecs };
}

test.afterEach(() => {
  // Back to the pristine, uncached state (undefined, not null) — the same "re-derive from env on
  // next read" reset every other engine-backend test in this repo leaves behind.
  resetEngineBackendCache(undefined);
});

// Bridges the JSON bubble envelope the real pipeline hands processConvoResult (repo convention,
// shared with composerParaphrase.test.ts / unkeptPromise.test.ts).
function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function listCall(): LlmToolCall {
  return { name: 'list_automations', input: {} };
}

function scheduleCall(over: Record<string, unknown> = {}): LlmToolCall {
  return {
    name: 'schedule_automation',
    input: {
      instruction: 'take the trash out', schedule_kind: 'cron', cron: '0 9 * * *',
      timezone: null, title: null, needs_ops: false, ops_kind: null, ...over,
    },
  };
}

function ctx(): ChatContext {
  const handle = `+1555800${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
};

// ── Task 1: an empty list is a true answer, not a correction ────────────────────────────────────

test("list_automations on an empty list ships the model's own honest reply, untouched", async () => {
  installStubEngine([]); // this chat has no reminders
  const a = baseArgs();
  const modelsOwnReply = "you don't have any reminders set up right now";
  const res = makeResult([modelsOwnReply], [listCall()]);

  const out = await processConvoResult({ ...a, res, textToSend: 'what reminders do i have?' });

  // Before the fix: renderAutomationsList answered `nothing_found` for zero items, and the
  // correction block in shared.ts replaces the shipped text with a FRESH Fallfirm voicing whenever
  // any outcome part isn't `confirmed` — so the model's own true sentence above never reached the
  // user; a hardcoded-floor line like "couldnt track that one down" did instead.
  assert.equal(out.text, modelsOwnReply, "the model's own accurate answer ships verbatim");
});

test('list_automations with reminders shows a short id and the next run time', async () => {
  installStubEngine([
    { id: '2448ff495f3b', title: 'daily brief', schedule: '0 7 * * *', nextRunAt: '2026-09-24T07:00:00+07:00' },
  ]);
  const a = baseArgs();
  // No text of its own — forces Fallfirm to voice the outcome's `facts` in full, so the raw list
  // line (built in shared.ts, not by the model) is exactly what a assert.match below can check.
  const res = makeResult([], [listCall()]);

  const out = await processConvoResult({ ...a, res, textToSend: 'what reminders do i have?', userTz: 'Asia/Jakarta' });

  assert.ok(out.text, 'never silent on a list');
  assert.match(out.text!, /R2448ff/, 'the short id (R + first 6 hex chars) is shown');
  assert.match(out.text!, /daily brief/);
});

// ── Task 2: a cron with no explicit timezone rides the USER's zone ──────────────────────────────

test("schedule_automation with no timezone in the call uses the turn's userTz, not the host's", async () => {
  const { createdSpecs } = installStubEngine();
  const a = baseArgs();
  const res = makeResult(["got it, i'll remind you"], [scheduleCall()]); // timezone: null in the call

  await processConvoResult({ ...a, res, textToSend: 'remind me every day at 9am to take the trash out', userTz: 'America/Chicago' });

  assert.equal(createdSpecs.length, 1, 'the reminder was created');
  // Before the fix, handleScheduleAutomation fell straight to DEFAULT_TZ (this process's host
  // zone — UTC under the test harness's TZ=UTC) whenever the model's own call carried no timezone,
  // never reading the userTz this turn already resolved.
  assert.equal(createdSpecs[0].timezone, 'America/Chicago');
});

test('schedule_automation still honors an EXPLICIT timezone in the call over userTz', async () => {
  const { createdSpecs } = installStubEngine();
  const a = baseArgs();
  const res = makeResult(["got it"], [scheduleCall({ timezone: 'Europe/London' })]);

  await processConvoResult({ ...a, res, textToSend: 'remind me at 9am london time', userTz: 'America/Chicago' });

  assert.equal(createdSpecs[0].timezone, 'Europe/London', "the model's own explicit zone wins");
});

// ── Task 4: a failure never erases a success beside it ──────────────────────────────────────────

test('a successful schedule is still voiced when a cancel in the same turn misses', async () => {
  // The 2026-09-23 incident, one turn of it: "change my 7am brief to government news". The model
  // cancelled by a title it guessed ("morning brief") and scheduled the replacement. The real title
  // was "daily indonesia digest", so the cancel missed — and the schedule landed. Its confirmation
  // lived in a single slot voiced only when the model wrote no text, and the correction for the miss
  // REPLACED the whole reply, so the user heard "no reminder matched" and never heard that a new 7am
  // job now existed. Four repeats left five of them on the engine.
  const { createdSpecs } = installStubEngine([
    { id: '2448ff495f3b', title: 'daily indonesia digest', schedule: '0 7 * * *' },
  ]);
  const a = baseArgs();
  const res = makeResult(['done, switched it to govt news'], [
    { name: 'cancel_automation', input: { match: 'morning brief' } },
    scheduleCall({ instruction: 'send me a brief on indonesian government news', cron: '0 7 * * *' }),
  ]);

  const out = await processConvoResult({ ...a, res, textToSend: 'change my 7am brief to govt news instead', userTz: 'Asia/Jakarta' });

  assert.equal(createdSpecs.length, 1, 'the replacement reminder was created');
  assert.ok(out.text, 'never silent');
  // The Fallfirm lane has no model under test, so each result lands as its floor line — the
  // schedule's confirmation and the cancel's miss, both, in the order they ran.
  assert.match(out.text!, /done, all set/, 'the reminder that WAS set is said');
  assert.match(out.text!, /couldnt track that one down/, 'and so is the cancel that missed');
  assert.doesNotMatch(out.text!, /switched it/, "the draft's claim that the swap happened does not ship");
});
