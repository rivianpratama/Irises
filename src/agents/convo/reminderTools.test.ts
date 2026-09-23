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
// module mocks) — same harness composerParaphrase.test.ts and unkeptPromise.test.ts use. The later
// tasks' tests (id-addressed reminder tools, the create-time hold) live here too.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import {
  resetEngineBackendCache, type EngineBackend, type ReminderPatch, type ReminderRef, type ReminderSpec,
} from '../ops/engineBackend.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// Minimal engine stub (repo DI convention): serves canned reminders and captures every write —
// createReminder specs (so a test can assert what timezone actually reached the engine), the ids a
// cancel deleted, and each updateReminder call.
function installStubEngine(reminders: ReminderRef[] = []): {
  createdSpecs: ReminderSpec[];
  cancelledIds: string[];
  updates: Array<{ id: string; patch: ReminderPatch }>;
} {
  const createdSpecs: ReminderSpec[] = [];
  const cancelledIds: string[] = [];
  const updates: Array<{ id: string; patch: ReminderPatch }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder(spec) { createdSpecs.push(spec); return { id: 'r1', title: spec.title ?? spec.instruction, schedule: spec.cron ?? '' }; },
    async listReminders() { return reminders; },
    async cancelReminder(id) { cancelledIds.push(id); return reminders.some(r => r.id === id); },
    async updateReminder(id, patch) {
      updates.push({ id, patch });
      const old = reminders.find(r => r.id === id);
      if (!old) return { ok: false, reason: 'not_found' };
      return { ok: true, ref: { ...old, title: patch.title ?? old.title, ...(patch.cron ? { expr: patch.cron, schedule: patch.cron } : {}) } };
    },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  resetEngineBackendCache(engine);
  return { createdSpecs, cancelledIds, updates };
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

test('list_automations with reminders shows each one by its title and next run, never by its id', async () => {
  installStubEngine([
    { id: '2448ff495f3b', title: 'daily brief', schedule: '0 7 * * *', nextRunAt: '2026-09-24T07:00:00+07:00' },
  ]);
  const a = baseArgs();
  // No text of its own — forces Fallfirm to voice the outcome's `facts` in full, so the raw list
  // line (built in shared.ts, not by the model) is exactly what a assert.match below can check.
  const res = makeResult([], [listCall()]);

  const out = await processConvoResult({ ...a, res, textToSend: 'what reminders do i have?', userTz: 'Asia/Jakarta' });

  assert.ok(out.text, 'never silent on a list');
  assert.match(out.text!, /daily brief — Thu, Sep 24, 7:00\sAM/, 'the title and the next run, in their zone');
  // The id is how the MODEL names a reminder (the live list, the outcome pass). The user reads
  // titles and times: a bracketed hex id relayed into their chat is noise they never asked for.
  assert.doesNotMatch(out.text!, /R2448ff/, 'the id stays model-facing');
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

test("a one-time reminder whose reply stands ships that reply alone, with no time tacked on", async () => {
  // Shipped: "got it, i'll ping you tomorrow at 9\n---\nfri, sep 25, 5:36 am". The model's line
  // stood, and the one-shot's exact time rode under it as a raw fact bubble, read in UTC.
  installStubEngine();
  const a = baseArgs();
  const fireAt = new Date(Date.now() + 36 * 3600_000).toISOString();
  const res = makeResult(["got it, i'll ping you tomorrow at 9"], [
    { name: 'schedule_automation', input: { instruction: 'call mom', schedule_kind: 'once', fire_at: fireAt } },
  ]);

  const out = await processConvoResult({ ...a, res, textToSend: 'remind me at 9pm tomorrow to call mom', userTz: 'UTC' });

  assert.equal(out.text, "got it, i'll ping you tomorrow at 9");
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

// ── Task 6: reminders addressed by the id the model can see ─────────────────────────────────────
// The incident's cancel matched a title substring the model had to guess. Worse, a match that fit
// several reminders used to be one outcome for all of them, and an id-only call (the shape the new
// tool asks for) read as an empty match, which fits EVERY reminder.

const MORNING: ReminderRef = {
  id: '2448ff495f3b', title: 'morning news brief', schedule: 'every day 7am', kind: 'cron', expr: '0 7 * * *',
  instruction: 'send me the economy headlines', nextRunAt: '2026-09-24T07:00:00+00:00',
};
const EVENING: ReminderRef = {
  id: '9d0c42fcef9d', title: 'evening news brief', schedule: 'every day 6pm', kind: 'cron', expr: '0 18 * * *',
  instruction: 'send me the sports headlines', nextRunAt: '2026-09-23T18:00:00+00:00',
};
const PLANTS: ReminderRef = {
  id: '42cbde8bd745', title: 'water the plants', schedule: 'every day 6pm', kind: 'cron', expr: '0 18 * * *',
  instruction: 'water the balcony plants', nextRunAt: '2026-09-23T18:00:00+00:00',
};

/** Pin the engine's own zone for a test that compares schedules, and put it back after. */
async function withEngineTz(tz: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HERMES_TZ;
  process.env.HERMES_TZ = tz;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.HERMES_TZ; else process.env.HERMES_TZ = prev;
  }
}

test('a cancel whose words fit two reminders cancels neither, and lists both', async () => {
  const { cancelledIds } = installStubEngine([MORNING, EVENING]);
  const a = baseArgs();
  const res = makeResult(['done, cancelled it'], [{ name: 'cancel_automation', input: { match: 'news brief' } }]);

  const out = await processConvoResult({ ...a, res, textToSend: 'cancel the news brief', userTz: 'UTC' });

  assert.deepEqual(cancelledIds, [], 'nothing is cancelled when the words fit more than one');
  assert.match(out.text!, /morning news brief/, 'the first candidate is offered by its title');
  assert.match(out.text!, /evening news brief/, 'and so is the second');
  assert.doesNotMatch(out.text!, /\[R/, 'never by the id the model addresses it with');
  assert.doesNotMatch(out.text!, /cancelled it/, "the draft's claim does not ship");
});

test('update_automation by short id sends one in-place update, and the reply confirms it', async () => {
  const { updates, createdSpecs, cancelledIds } = installStubEngine([MORNING, EVENING]);
  const a = baseArgs();
  const res = makeResult(['done, moved it to 8'], [
    { name: 'update_automation', input: { id: 'R2448ff', cron: '0 8 * * *' } },
  ]);

  const out = await processConvoResult({ ...a, res, textToSend: 'move my morning brief to 8', userTz: 'Asia/Jakarta' });

  assert.equal(updates.length, 1, 'one update call, no cancel-and-recreate');
  assert.equal(updates[0].id, MORNING.id, 'the short id resolved to the full engine id');
  assert.equal(updates[0].patch.cron, '0 8 * * *');
  assert.equal(updates[0].patch.timezone, 'Asia/Jakarta', "the cron rides the user's zone");
  assert.equal(updates[0].patch.chatId, a.chatId);
  assert.equal(updates[0].patch.scheduleKind, undefined, 'same shape, so the in-place path');
  assert.deepEqual([createdSpecs.length, cancelledIds.length], [0, 0]);
  // It ships alone: the model wrote it knowing the change, and only a list is data it cannot author.
  // An appended "[R2448ff] morning news brief (…)" was an id and a stale title under her words.
  assert.equal(out.text, 'done, moved it to 8', "the model's own confirmation ships, and only it");
});

test('an unknown id is not_found, and what they do have is offered', async () => {
  const { cancelledIds } = installStubEngine([MORNING, EVENING]);
  const a = baseArgs();
  const res = makeResult(['cancelled'], [{ name: 'cancel_automation', input: { id: 'R777777' } }]);

  const out = await processConvoResult({ ...a, res, textToSend: 'cancel that reminder', userTz: 'UTC' });

  assert.deepEqual(cancelledIds, [], 'an id that names nothing cancels nothing');
  assert.match(out.text!, /couldnt track that one down/, 'said as a miss');
  assert.match(out.text!, /morning news brief/, 'with what they do have');
  assert.match(out.text!, /evening news brief/);
});

// ── Task 9: a create that collides with an existing reminder is held ────────────────────────────

test('a second 7am daily in different words is HELD, not created, and the reply names the existing one', async () => {
  // The incident's end state was five enabled 7am jobs: every repeat of "switch my brief" added one.
  // `distinct:true` is the model's claim that this one serves another purpose, and on the first
  // pass it has not yet seen what it collides with, so the claim is ignored there.
  await withEngineTz('UTC', async () => {
    const { createdSpecs } = installStubEngine([MORNING]);
    const a = baseArgs();
    clearTraces();
    const res = makeResult(['got it, 7am govt news every day'], [scheduleCall({
      title: 'govt news', instruction: 'send me indonesian government news', cron: '0 7 * * *', distinct: true,
    })]);

    const out = await processConvoResult({ ...a, res, textToSend: 'add a 7am govt news reminder', userTz: 'UTC' });

    assert.equal(createdSpecs.length, 0, 'held: no second job lands on the same slot');
    assert.match(out.text!, /morning news brief/, 'the reminder already on that slot is named');
    assert.doesNotMatch(out.text!, /got it, 7am/, "the draft's claim that it was set does not ship");
    const ignored = getTraces().find(e => e.label === 'convo:tool_arg_ignored' && (e.detail as { arg?: string } | undefined)?.arg === 'distinct');
    assert.ok(ignored, 'the ignored distinct claim is on the record');
  });
});

test('cancel(id) + schedule for the same slot in one turn creates the new one', async () => {
  // The per-turn ledger: the cancel runs first (canonical order) and takes the old reminder out of
  // what this turn's create is checked against, so the replacement is not held by the very reminder
  // it replaces.
  await withEngineTz('UTC', async () => {
    const { createdSpecs, cancelledIds } = installStubEngine([MORNING, PLANTS]);
    const a = baseArgs();
    const res = makeResult(['switched it to govt news'], [
      scheduleCall({ title: 'govt news', instruction: 'send me indonesian government news', cron: '0 7 * * *' }),
      { name: 'cancel_automation', input: { id: 'R2448ff' } },
    ]);

    await processConvoResult({ ...a, res, textToSend: 'swap my 7am brief for govt news', userTz: 'UTC' });

    assert.deepEqual(cancelledIds, [MORNING.id], 'the id named exactly one reminder');
    assert.equal(createdSpecs.length, 1, 'the replacement is created');
  });
});
