// Coverage for the outcome pass: the ONE more look the convo model gets at a turn whose actions did
// not all land, with the real results and the live ids in front of it, so it can fix the call by id
// and write a reply that carries on from what they asked (convo/shared.ts, beside the recall pass).
//
// The live 2026-09-23 incident is the first test, end to end: "change my 7am brief to government
// news". The model cancelled by a title it guessed ("morning brief") and scheduled the replacement.
// The real title was something else, so the cancel missed and the create was held against the very
// reminder it meant to replace, and the reply the user got was a canned "no match". Four repeats of
// that left five 7am jobs. With the pass, the model sees the reminder's id and revises it in place.
//
// Same harness as recallMemory.test.ts (the injected `turn.call` seam, the trace ring) with the stub
// engine reminderTools.test.ts uses. Runs against the ephemeral DB backend.

process.env.DATA_BACKEND = 'memory';
// The engine's own zone, pinned so the create-time slot check reads both schedules in one zone.
process.env.HERMES_TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import {
  REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL, CHECK_ERROR_LOG_TOOL, SCHEDULE_AUTOMATION_TOOL,
  CANCEL_AUTOMATION_TOOL, UPDATE_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL,
} from './tools.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { __resetLiveReminders } from './liveReminders.js';
import {
  resetEngineBackendCache, type EngineBackend, type ReminderPatch, type ReminderRef, type ReminderSpec,
} from '../ops/engineBackend.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';

function installStubEngine(reminders: ReminderRef[]): {
  createdSpecs: ReminderSpec[];
  updates: Array<{ id: string; patch: ReminderPatch }>;
} {
  const createdSpecs: ReminderSpec[] = [];
  const updates: Array<{ id: string; patch: ReminderPatch }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder(spec) { createdSpecs.push(spec); return { id: `new${createdSpecs.length}aaaaaa`, title: spec.title ?? spec.instruction, schedule: spec.cron ?? '' }; },
    async listReminders() { return reminders; },
    async cancelReminder(id) { return reminders.some(r => r.id === id); },
    async updateReminder(id, patch) {
      updates.push({ id, patch });
      const old = reminders.find(r => r.id === id);
      if (!old) return { ok: false, reason: 'not_found' };
      return { ok: true, ref: { ...old, title: patch.title ?? old.title, instruction: patch.instruction ?? old.instruction } };
    },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  resetEngineBackendCache(engine);
  return { createdSpecs, updates };
}

test.afterEach(() => { resetEngineBackendCache(undefined); });

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

/** The turn context client.ts hands processConvoResult, with the model call injected and recorded. */
function turnCtx(ask: string, call: (req: LlmRequest) => Promise<LlmResult>): { turn: ConvoTurnContext; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  return {
    seen,
    turn: {
      system: 'SYSTEM PROMPT (persona + this turn)',
      messages: [{ role: 'user', content: ask }],
      tools: [
        REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL, CHECK_ERROR_LOG_TOOL, SCHEDULE_AUTOMATION_TOOL,
        CANCEL_AUTOMATION_TOOL, UPDATE_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL,
      ],
      call: async req => { seen.push(req); return call(req); },
    },
  };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  __resetLiveReminders();
  clearTraces();
  const sender = `+1555830${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend, userTz: 'UTC' };
}

function schedule(instruction: string, cron: string, over: Record<string, unknown> = {}): LlmToolCall {
  return { name: 'schedule_automation', input: { instruction, schedule_kind: 'cron', cron, ...over } };
}

function outcomeReceipt(): Record<string, unknown> | undefined {
  return getTraces().find(e => e.type === 'event' && e.label === 'convo:outcome_pass')?.detail as Record<string, unknown> | undefined;
}

// The reminder the incident's user actually had. Its title is not the words the model guessed.
const DIGEST: ReminderRef = {
  id: '9d0c42fcef9d', title: 'daily indonesia digest', schedule: 'every day 7am', kind: 'cron', expr: '0 7 * * *',
  instruction: 'send me the indonesian economy headlines', nextRunAt: '2026-09-24T07:00:00+00:00',
};
const GOVT = 'send me indonesian government news';

test('the incident: a missed cancel and a held create become ONE in-place update by id, in her words', async () => {
  const { createdSpecs, updates } = installStubEngine([DIGEST]);
  const ask = 'change my 7am brief to govt news instead';
  const a = args(ask);
  const { turn, seen } = turnCtx(ask, async () => makeResult(
    ['done, your 7am one is govt news now', 'same time as before'],
    [{ name: 'update_automation', input: { id: 'R9d0c42', instruction: GOVT } }],
  ));

  const out = await processConvoResult({
    ...a,
    res: makeResult(['done, switched it to govt news'], [
      { name: 'cancel_automation', input: { match: 'morning brief' } },
      schedule(GOVT, '0 7 * * *'),
    ]),
    turn,
  });

  assert.equal(seen.length, 1, 'exactly one more look');
  assert.ok(1 + seen.length <= 3, 'within the three convo calls a turn may make');
  const pass = seen[0];
  assert.deepEqual(
    pass.tools?.filter(t => t.name === 'recall_memory' || t.name === 'check_error_log'), [],
    'the searches are stripped from the pass',
  );
  const shown = String(pass.messages[pass.messages.length - 1].content);
  assert.match(shown, /<action_results>/);
  assert.match(shown, /R9d0c42/, 'the live reminder is shown by its id');

  assert.equal(updates.length, 1, 'one in-place update');
  assert.equal(updates[0].id, DIGEST.id, 'aimed at the reminder they had');
  assert.equal(updates[0].patch.instruction, GOVT);
  assert.equal(createdSpecs.length, 0, 'no second 7am job');
  assert.match(out.text!, /done, your 7am one is govt news now/, "the pass's own reply ships");
  assert.doesNotMatch(out.text!, /no reminder matched|couldnt track/, 'no canned miss');
  assert.equal(outcomeReceipt()?.resolved, 'model');
});

test('a pass that throws falls back to voicing every result, the success included, with no third call', async () => {
  const { createdSpecs } = installStubEngine([DIGEST]);
  const ask = 'remind me at 9pm to take the trash out, and drop the gym one';
  const a = args(ask);
  const { turn, seen } = turnCtx(ask, async () => { throw new Error('provider down'); });

  const out = await processConvoResult({
    ...a,
    res: makeResult(['ok, trash at 9pm and the gym one is gone'], [
      schedule('take the trash out', '0 21 * * *'),
      { name: 'cancel_automation', input: { match: 'gym' } },
    ]),
    turn,
  });

  assert.equal(createdSpecs.length, 1, 'the trash reminder was set');
  assert.equal(seen.length, 1, 'the pass was tried once and nothing after it');
  assert.match(out.text!, /done, all set/, 'the reminder that WAS set is said');
  assert.match(out.text!, /couldnt track that one down/, 'and so is the cancel that missed');
  assert.equal(outcomeReceipt()?.resolved, 'fallback_throw');
});

test('a parked approval with a failed cancel beside it gets no pass, and its question ships', async () => {
  installStubEngine([DIGEST]);
  const ask = 'email my landlord that rent is late, and drop the gym reminder';
  const a = args(ask);
  const { turn, seen } = turnCtx(ask, async () => makeResult(['want me to send that to your landlord?']));

  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [
      { name: 'delegate_to_ops', input: { kind: 'general', request: 'email my landlord that rent is late', effect: 'act' } },
      { name: 'cancel_automation', input: { match: 'gym' } },
    ]),
    turn,
  });

  assert.deepEqual(seen.map(r => r.trace?.label), ['convo:approval_retry'], 'the approval ask, and no outcome pass');
  assert.equal(outcomeReceipt(), undefined);
  assert.match(out.text!, /want me to send that to your landlord\?/, 'the question survives');
});

test('a held create goes through on the pass when it is marked distinct there', async () => {
  const { createdSpecs } = installStubEngine([DIGEST]);
  const ask = 'also a 7am weather reminder every day';
  const a = args(ask);
  const { turn } = turnCtx(ask, async () => makeResult(
    ['ok, a separate 7am weather one then'],
    [schedule('send me the jakarta weather forecast', '0 7 * * *', { title: 'weather', distinct: true })],
  ));

  await processConvoResult({
    ...a,
    res: makeResult(['got it, weather at 7 every day'], [
      schedule('send me the jakarta weather forecast', '0 7 * * *', { title: 'weather' }),
    ]),
    turn,
  });

  assert.equal(createdSpecs.length, 1, 'created once, on the pass that saw the collision');
  assert.equal(createdSpecs[0].instruction, 'send me the jakarta weather forecast');
  assert.equal(outcomeReceipt()?.resolved, 'model');
});
