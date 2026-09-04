// The steer_research surface: the tool as the model sees it, the branch table behind it, and the
// two things renderActiveOps now says about a run the user has added to.
//
// DI where it is needed and nowhere else (a stub EngineBackend, the in-memory coordination map) —
// no module mocks. The engine is passed in rather than resolved from OPS_BACKEND because
// getEngineBackend caches per process: one test file cannot otherwise have both an engine that can
// steer and one that cannot.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSteerResearch, renderActiveOps } from './shared.js';
import { STEER_RESEARCH_TOOL, convoToolList } from './tools.js';
import {
  markOpsStart, markOpsDone, noteOpsEngineRun, getActiveOps, takePendingSteers,
  beginOpsEngineLeg, endOpsEngineLeg, noteOpsSteerUnreachable,
  __resetOpsCoordination, type ActiveOps,
} from '../../state/opsCoordination.js';
import type { EngineBackend, EngineRunHandle } from '../ops/engineBackend.js';

const HANDLE = '+15550001111';

/** An engine that can steer, recording what it was asked to deliver. `hold` leaves the POST pending
 *  for ever, which is how the "the Outcome must not wait on the network" test is written. */
function steerableEngine(
  calls: Array<{ handle: EngineRunHandle; text: string }>,
  opts: { hold?: boolean } = {},
): EngineBackend {
  return {
    name: 'hermes',
    async runTask() { throw new Error('not used'); },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    async steerRun(handle, text) {
      calls.push({ handle, text });
      if (opts.hold) return new Promise<'accepted'>(() => { /* never settles */ });
      return 'accepted';
    },
  };
}

/** An engine with no steer route at all — OpenClaw today. */
function unsteerableEngine(): EngineBackend {
  const be = steerableEngine([]) as Record<string, unknown>;
  delete be.steerRun;
  return be as unknown as EngineBackend;
}

// ── the tool the model sees ──────────────────────────────────────────────────

test('steer_research is offered on the live tool list, right beside cancel_research', () => {
  const names = convoToolList({ engineName: 'hermes', isGroupChat: false, selfUpdate: false })
    .map(t => t.name);
  assert.ok(names.includes('steer_research'), 'the assembled list carries it');
  assert.equal(names[names.indexOf('cancel_research') + 1], 'steer_research', 'the two sit together');
  // The group and openclaw lanes are the same list plus/minus their own tools — a steer is neither.
  assert.ok(convoToolList({ engineName: 'openclaw', isGroupChat: true, selfUpdate: true })
    .map(t => t.name).includes('steer_research'));
});

test('the tool asks for the addition in their words, and only guidance is required', () => {
  const schema = STEER_RESEARCH_TOOL.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['guidance']);
  assert.deepEqual(Object.keys(schema.properties), ['guidance', 'match']);
  // The two confusions that would cost a run: a different ask, and a stop.
  assert.match(STEER_RESEARCH_TOOL.description, /NOT for a wholly different ask/);
  assert.match(STEER_RESEARCH_TOOL.description, /NOT for a stop \(that's cancel_research\)/);
});

// ── handleSteerResearch, branch by branch ───────────────────────────────────

test('nothing running → honest nothing_found, and it reads as a fresh ask', () => {
  __resetOpsCoordination();
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, null);
  assert.equal(note?.kind, 'nothing_found');
  assert.match(note?.nextStep ?? '', /fresh ask/);
});

test('a match that fits nothing → nothing_found listing what IS running', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  const note = handleSteerResearch('mortgage rates', 'only under 100k', 'chatA', HANDLE, null);
  assert.equal(note?.kind, 'nothing_found');
  assert.match(note?.facts ?? '', /full inbox scan/);
  // Nothing was added to a run it might not belong to.
  assert.equal(getActiveOps('chatA')[0].steers, undefined);
});

test('several running + empty match → failed outcome that lists them, and adds to none', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  markOpsStart('chatA', 't2', { kind: 'web_research', request: 'comps on 412 maple' });
  const note = handleSteerResearch('', 'actually jakarta', 'chatA', HANDLE, null);
  assert.equal(note?.kind, 'failed');
  assert.match(note?.facts ?? '', /full inbox scan/);
  assert.match(note?.facts ?? '', /comps on 412 maple/);
  assert.ok(getActiveOps('chatA').every(o => o.steers === undefined));
});

test('blank guidance is a no-op — nothing is sent, and it does not read back as "just finished"', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  noteOpsEngineRun('chatA', 't1', { engine: 'hermes', runId: 'run_7' });
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  // Whitespace-only guidance used to fall into requestOpsSteer's blank-text branch, which reads
  // identically to the run having already ended — the still-running lookup got told it was over.
  // A blank addition is nothing said at all: Convo's own ack stands, the map is never touched, and
  // nothing is POSTed.
  const note = handleSteerResearch('', '   ', 'chatA', HANDLE, steerableEngine(calls));
  assert.equal(note, null);
  assert.equal(calls.length, 0, 'nothing to steer with, so nothing was sent');
  assert.equal(getActiveOps('chatA')[0].steers, undefined, 'the map was never consulted');
  markOpsDone('chatA', 't1');
});

test('the leg finished while she was reading the turn → the correction says so, and nothing is POSTed', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  beginOpsEngineLeg('chatA', 't1', true);
  noteOpsEngineRun('chatA', 't1', { engine: 'hermes', runId: 'run_7' });
  // The engine leg is over; the task is still in flight while triage and compose run. hermes
  // answers 409 to a steer at a finished run, so an "adding that in" ack here would be a lie.
  endOpsEngineLeg('chatA', 't1');
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, steerableEngine(calls));
  assert.equal(note?.kind, 'failed');
  assert.match(note?.summary ?? '', /just finished/);
  assert.equal(calls.length, 0, 'nothing was aimed at a run that is over');
});

test('a transport with no run id → the unsupported note, even from an engine that CAN steer', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  beginOpsEngineLeg('chatA', 't1', true);
  // hermes on the chat transport: it has a steer route, but this run has no id to aim it at. The
  // addition would otherwise sit queued for a handle that is never coming, and the user would hear
  // "adding that in" about nothing.
  noteOpsSteerUnreachable('chatA', 't1');
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, steerableEngine(calls));
  assert.equal(note?.kind, 'failed');
  assert.match(note?.nextStep ?? '', /work it into the answer when it lands/);
  assert.equal(calls.length, 0);
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['also check jakarta'], 'their words stay with the task');
});

test('an engine with no steer route → the honest failed note, and the addition is still kept', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  noteOpsEngineRun('chatA', 't1', { engine: 'openclaw', runId: 'run_x' });
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, unsteerableEngine());
  assert.equal(note?.kind, 'failed');
  assert.match(note?.nextStep ?? '', /work it into the answer when it lands/);
  // The promise that note makes: their words stay with the task, for the status line and the leg.
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['also check jakarta']);
});

test('a handle in hand → null (her own ack stands) and the wrapped addition goes to the engine', async () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  noteOpsEngineRun('chatA', 't1', { engine: 'hermes', runId: 'run_7' });
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  assert.equal(handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, steerableEngine(calls)), null);
  await new Promise(r => setImmediate(r)); // the POST is dispatched, not awaited
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].handle, { engine: 'hermes', runId: 'run_7' });
  assert.match(calls[0].text, /The user just added to this task mid-run: "also check jakarta"/);
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['also check jakarta']);
});

test('the Outcome never waits on the network — a POST that never answers still returns at once', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  noteOpsEngineRun('chatA', 't1', { engine: 'hermes', runId: 'run_7' });
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, steerableEngine(calls, { hold: true }));
  assert.equal(note, null);
  assert.equal(calls.length, 1, 'the ladder started');
});

test('no engine handle yet → null, and the addition waits in the queue for the run to be reachable', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  assert.equal(handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, steerableEngine(calls)), null);
  assert.equal(calls.length, 0, 'nothing to aim at, so nothing was POSTed');
  assert.deepEqual(takePendingSteers('chatA', 't1'), ['also check jakarta']);
});

test('a match steers only the lookup it names', async () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  markOpsStart('chatA', 't2', { kind: 'web_research', request: 'comps on 412 maple' });
  noteOpsEngineRun('chatA', 't2', { engine: 'hermes', runId: 'run_maple' });
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  assert.equal(handleSteerResearch('maple', 'only under 100k', 'chatA', HANDLE, steerableEngine(calls)), null);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].handle.runId, 'run_maple');
  const byTask = new Map(getActiveOps('chatA').map(o => [o.taskId, o.steers]));
  assert.deepEqual(byTask.get('t2'), ['only under 100k']);
  assert.equal(byTask.get('t1'), undefined);
});

test('steering is chat-scoped: another chat\'s lookup is untouchable', () => {
  __resetOpsCoordination();
  markOpsStart('chatB', 't1', { kind: 'general', request: 'full inbox scan' });
  const note = handleSteerResearch('', 'also check jakarta', 'chatA', HANDLE, null);
  assert.equal(note?.kind, 'nothing_found');
  assert.equal(getActiveOps('chatB')[0].steers, undefined);
});

// ── renderActiveOps ─────────────────────────────────────────────────────────

const NOW = Date.now();
const running = (extra: Partial<ActiveOps> = {}): ActiveOps => ({
  taskId: 'op1', kind: 'web_research', request: 'cedar lead times',
  startedAt: NOW - 40_000, firstStartedAt: NOW - 40_000, lastMilestone: 'engine',
  estimateMs: 120_000, estimatePhrase: 'a couple minutes', ...extra,
});

test('the steer/redirect instruction block is there, and the STOP block still comes last', () => {
  const out = renderActiveOps([running()]);
  const steerAt = out.indexOf('call steer_research with their addition as `guidance`');
  const stopAt = out.indexOf('If they tell you to STOP');
  assert.ok(steerAt > 0, 'the steer instruction is rendered');
  assert.ok(stopAt > steerAt, 'it sits above the stop block, which stays at the recency edge');
  assert.ok(out.trimEnd().endsWith('A bare "ok"/"thanks" is NEVER a cancel.'), 'the stop block is last');
  // The redirect has no plumbing of its own — it is these two tools in one turn, and only the
  // prompt can say so.
  assert.match(out, /call cancel_research AND delegate_to_ops in this same turn/);
});

test('what they added rides on the status line — running and queued alike', () => {
  const one = renderActiveOps([running({ steers: ['also check jakarta'] })]);
  assert.match(one, /— you added: "also check jakarta"/);
  const two = renderActiveOps([running({ steers: ['also check jakarta', 'under 100k'] })]);
  assert.match(two, /— you added: "also check jakarta"; "under 100k"/);
  const queued = renderActiveOps([running({ lastMilestone: 'queued', steers: ['under 100k'] })]);
  assert.match(queued, /hasn't started yet \(waiting for a free slot\) — you added: "under 100k"/);
  // An ordinary run says nothing about additions at all.
  assert.ok(!renderActiveOps([running()]).includes('you added'));
});
