// The schema echo, end to end at the processConvoResult seam — the live 2026-09-15 17:45 turn.
//
// The model returned one real `delegate_to_ops` and then eleven more `tool_calls` entries, one per
// offered tool, every arg null. Null args are stripped upstream, so all eleven reached dispatch as
// `{ name, input: {} }`: six handlers answered empty input with a `failed`/`nothing_found` outcome,
// Fallfirm voiced one bubble each, and because a correction outcome REPLACES the model's text the
// user got eight phantom "nothing else" bubbles instead of the reply they were waiting on
// ("pulling the rest of that indonesia scan now"). `update_memory{}` also fired the engine's
// remember pass with the user's own text through its `input.request ?? textToSend` fallback.
//
// What is pinned here is the wiring: the guard runs ONCE at the top of the turn and every reader
// downstream of it sees the kept list — the dispatch loop, and (the second test) the silent-turn
// floor, for which a dump with no bubbles and no real call is a silent turn like any other.
// The rules themselves are pinned pure in toolCallGuard.test.ts. Runs end-to-end against the
// ephemeral DB backend with the LLM injected (repo DI convention).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { convoToolList } from './tools.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';

const ASK = 'and the rest of that indonesia list?';
const HOLDING = 'pulling the rest of that indonesia scan now';
const REQUEST = 'the rest of the indonesia relocation scan';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 80,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

/** The real call the user was actually waiting on. */
const DELEGATE: LlmToolCall = {
  name: 'delegate_to_ops',
  input: { kind: 'web_research', request: REQUEST, effect: 'read', meta_prompt: 'finish the sweep and bring back the rest of the list' },
};

/** The echo, in the order the model wrote it: one entry per remaining offered tool, no args. */
const ECHO_NAMES = [
  'remember_user', 'set_preference', 'schedule_automation', 'list_automations', 'cancel_automation',
  'cancel_research', 'steer_research', 'update_directives', 'update_memory', 'recall_memory',
  'send_reaction',
];
const ECHO: LlmToolCall[] = ECHO_NAMES.map(name => ({ name, input: {} }));

let seq = 0;
function args() {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555700${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return {
    chatId: randomUUID(),
    handle: sender,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend: ASK,
  };
}

function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: ASK }],
    tools: convoToolList({ engineName: 'hermes', isGroupChat: false }),
    call,
  };
}

/** Fallfirm voicing is visible in the ring either way: a successful voicing records `fallfirm:<kind>`
 *  and the hardcoded floor under it records `fallfirm:floor_engaged` through the error log. */
function fallfirmTraces() {
  return getTraces().filter(e => e.label?.startsWith('fallfirm') || e.role === 'fallfirm');
}

test('the live echo turn: the real delegation stands, the eleven empties never dispatch', async () => {
  const a = args();
  let calls = 0;
  const out = await processConvoResult({
    ...a,
    res: makeResult([HOLDING], [DELEGATE, ...ECHO]),
    turn: turnCtx(async () => { calls++; return makeResult(['unused'], []); }),
  });

  assert.equal(calls, 0, 'no second model call — the empty recall_memory never became a search');
  assert.equal(out.text, HOLDING, 'the reply the user was waiting on, not a voiced correction');
  assert.ok(!out.text?.includes('\n---\n'), 'and nothing appended beside it');
  assert.equal(out.delegatedTask?.request, REQUEST, 'the one real action still happened');
  assert.equal(out.reaction, null, 'the empty send_reaction produced no tapback');
  assert.deepEqual(fallfirmTraces(), [], 'no outcome was voiced, so Fallfirm never ran');
});

test('the drop leaves exactly one receipt, naming what was discarded and why', async () => {
  const a = args();
  await processConvoResult({
    ...a,
    res: makeResult([HOLDING], [DELEGATE, ...ECHO]),
    turn: turnCtx(async () => makeResult(['unused'], [])),
  });

  const events = getTraces().filter(e => e.label === 'convo:tool_call_dropped');
  assert.equal(events.length, 1, 'one receipt per turn, not one per dropped call');
  const detail = (events[0].detail ?? {}) as { dropped?: string[]; reasons?: string[]; total?: number };
  assert.deepEqual(detail.dropped, ECHO_NAMES, 'every discarded name, in the order the model wrote them');
  assert.equal(detail.total, 12, 'measured against what the model actually wrote');
  assert.equal(detail.reasons?.length, 11, 'and a reason per dropped call');
  assert.equal(events[0].chatId, a.chatId);
});

test('a clean envelope leaves no receipt at all', async () => {
  const a = args();
  const out = await processConvoResult({
    ...a,
    res: makeResult([HOLDING], [DELEGATE]),
    turn: turnCtx(async () => makeResult(['unused'], [])),
  });
  assert.equal(out.text, HOLDING);
  assert.equal(getTraces().filter(e => e.label === 'convo:tool_call_dropped').length, 0);
});

test('a corrective re-ask that comes back a dump is guarded too', async () => {
  // The other way a schema echo reaches dispatch: not in the model's first draft but in the
  // REPLACEMENT a backstop asked for. The first draft here promises a look with no call and nothing
  // running, so the honesty guard spends its one re-ask, and the retry is the live dump shape — one
  // real `delegate_to_ops` and eleven empties. That result is adopted as the turn's own further
  // down, so the guard has to read it there as well as at the top, or the eleven dispatch exactly as
  // they did before the fix.
  const a = args();
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
  const out = await processConvoResult({
    ...a,
    res: makeResult(['hang tight, pulling the rest of that list'], []),
    turn: turnCtx(async () => makeResult([HOLDING], [DELEGATE, ...ECHO])),
  });

  assert.equal(out.text, HOLDING, 'the retry\'s own bubble ships');
  assert.ok(!out.text?.includes('\n---\n'), 'with no voiced outcome appended beside it');
  assert.equal(out.delegatedTask?.request, REQUEST, 'the retry\'s one real action still happened');
  assert.deepEqual(fallfirmTraces(), [], 'no outcome was voiced, so Fallfirm never ran');

  const events = getTraces().filter(e => e.label === 'convo:tool_call_dropped');
  assert.equal(events.length, 1, 'one receipt, for the envelope that actually carried the echo');
  const detail = (events[0].detail ?? {}) as { dropped?: string[]; total?: number };
  assert.deepEqual(detail.dropped, ECHO_NAMES, 'every discarded name, in the order the model wrote them');
  assert.equal(detail.total, 12, 'measured against what the retry wrote');
});

test('a dump with no bubbles and no real call IS a silent turn: the retry ladder runs', async () => {
  // Nothing the user or the thread can see: every call is an echo, so after the guard this turn did
  // literally nothing — which is the shape the silent-turn floor exists for. Before the guard the
  // eleven names alone made the floor stand down (`!res.toolCalls.length`), and the phantom outcome
  // bubbles were the only thing the user got back.
  const a = args();
  let calls = 0;
  const out = await processConvoResult({
    ...a,
    res: makeResult([], ECHO),
    turn: turnCtx(async () => { calls++; return makeResult(['sorry, what were we on?'], []); }),
  });
  assert.equal(calls, 1, 'exactly one retry of the same input, as an empty envelope gets');
  assert.equal(out.text, 'sorry, what were we on?', 'and the retry ships');
  assert.equal(getTraces().filter(e => e.label === 'convo:silent_turn').length, 1);
});

test('a dump-only turn with no retry available still says something honest', async () => {
  const a = args();
  const out = await processConvoResult({ ...a, res: makeResult([], ECHO) });
  assert.ok(out.text && out.text.trim().length, 'the user is never left on read');
});
