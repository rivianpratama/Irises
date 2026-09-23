// Coverage for the schema-echo guard — the shape test that tells a turn's real actions apart from a
// weak model reciting its own tool list back at us.
//
// The live failure (2026-09-15 17:45): the convo model returned one real `delegate_to_ops` and then
// eleven more `tool_calls` entries, one per offered tool, every arg null. Null args are stripped
// upstream (pipeline/bubbleJson.ts extractToolCalls), so each arrived at dispatch as `{ name,
// input: {} }`, six handlers produced a correction outcome for empty input, and the voiced
// corrections REPLACED the model's real bubble.
//
// The pure half is pinned here: the two rules, their precedence, and the three legitimately argless
// tools that must survive a LONE call. The wiring (which readers see the kept list, and the receipt)
// is pinned end-to-end in schemaEcho.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSchemaEcho } from './toolCallGuard.js';
import {
  convoToolList, CANCEL_RESEARCH_TOOL, LIST_AUTOMATIONS_TOOL, RECALL_MEMORY_TOOL,
} from './tools.js';
import type { LlmToolCall, LlmToolDef } from '../../llm/types.js';

// The superset the guard is looked up against in production when a caller passes no turn context.
const TOOLS = convoToolList({ engineName: 'hermes', isGroupChat: true });

const empty = (name: string): LlmToolCall => ({ name, input: {} });

/** Every offered tool whose `inputSchema.required` is non-empty — R1's whole population. */
function requiredArgTools(): LlmToolDef[] {
  return TOOLS.filter(t => ((t.inputSchema as { required?: unknown }).required as unknown[] | undefined)?.length);
}

// The live envelope, in the order the model wrote it: one real call, then one empty per offered tool.
const LIVE_REAL: LlmToolCall = {
  name: 'delegate_to_ops',
  input: { kind: 'web_research', request: 'the rest of the indonesia scan', effect: 'read', meta_prompt: 'finish the sweep' },
};
const LIVE_ECHO = [
  'remember_user', 'set_preference', 'schedule_automation', 'list_automations', 'cancel_automation',
  'cancel_research', 'steer_research', 'update_directives', 'update_memory', 'recall_memory',
  'send_reaction',
].map(empty);

// ── R1: empty input against a tool that REQUIRES args ────────────────────────

test('R1 drops every required-args tool called with no args at all', () => {
  const tools = requiredArgTools();
  assert.ok(tools.length >= 8, 'the live list carries the required-args tools this rule is for');
  for (const tool of tools) {
    const r = dropSchemaEcho([empty(tool.name)], TOOLS);
    assert.deepEqual(r.kept, [], `${tool.name}{} can only produce an error bubble`);
    assert.deepEqual(r.dropped, [{ name: tool.name, reason: 'required_args_missing' }]);
  }
});

test('R1 needs no second call to fire: a lone required-args echo is still an echo', () => {
  const r = dropSchemaEcho([empty('recall_memory')], TOOLS);
  assert.deepEqual(r.dropped, [{ name: 'recall_memory', reason: 'required_args_missing' }]);
});

// ── the three legitimately argless tools ─────────────────────────────────────
// No `required` in their inputSchema, and a cancel that names nothing stops the one look they asked
// for — so "drop empty args" would have broken real turns. This is why R2 reads the
// envelope's SHAPE instead.

test('a LONE argless call is real intent and is kept', () => {
  for (const tool of [LIST_AUTOMATIONS_TOOL, CANCEL_RESEARCH_TOOL]) {
    const r = dropSchemaEcho([empty(tool.name)], TOOLS);
    assert.deepEqual(r.kept, [empty(tool.name)], `${tool.name} is legitimately argless`);
    assert.deepEqual(r.dropped, []);
  }
});

test('an argless call beside an args-bearing one is kept — one empty is not a dump', () => {
  // The shape convo/recallMemory.test.ts already pins: a search plus a list, both real.
  const calls: LlmToolCall[] = [
    { name: RECALL_MEMORY_TOOL.name, input: { query: 'fence guy' } },
    empty(LIST_AUTOMATIONS_TOOL.name),
  ];
  const r = dropSchemaEcho(calls, TOOLS);
  assert.deepEqual(r.kept, calls);
  assert.deepEqual(r.dropped, []);
});

// ── R2: two or more empties in one envelope is the dump signature ────────────

test('R2 drops every empty-input call once two or more of them ride together', () => {
  const r = dropSchemaEcho([empty('list_automations'), empty('cancel_research')], TOOLS);
  assert.deepEqual(r.kept, [], 'no real turn needs two argless tools at once');
  assert.deepEqual(r.dropped, [
    { name: 'list_automations', reason: 'schema_echo' },
    { name: 'cancel_research', reason: 'schema_echo' },
  ]);
});

test('the live envelope keeps the one real call and drops all eleven echoes', () => {
  const r = dropSchemaEcho([LIVE_REAL, ...LIVE_ECHO], TOOLS);
  assert.deepEqual(r.kept, [LIVE_REAL], 'the delegation the user was actually waiting on');
  assert.equal(r.dropped.length, 11);
  // R1 beats R2 on a call that matches both: its reason is true of the call on its own, without
  // reference to what else the envelope carried.
  assert.deepEqual(r.dropped.filter(d => d.reason === 'schema_echo').map(d => d.name), [
    'remember_user', 'list_automations', 'cancel_research',
  ], 'the three tools with no required args are the only ones R2 has to explain');
  assert.equal(r.dropped.filter(d => d.reason === 'required_args_missing').length, 8);
});

// ── what the guard never touches ─────────────────────────────────────────────

test('a call WITH args survives inside a dump', () => {
  const real: LlmToolCall = { name: 'cancel_research', input: { match: 'the indonesia scan' } };
  const r = dropSchemaEcho([real, ...LIVE_ECHO], TOOLS);
  assert.deepEqual(r.kept, [real], 'args are intent, whatever the rest of the envelope looks like');
  assert.equal(r.dropped.length, 11);
});

test('a name the tool list does not carry is kept — dispatch ignores it anyway', () => {
  const r = dropSchemaEcho([empty('invented_tool'), empty('also_invented')], TOOLS);
  assert.deepEqual(r.kept, [empty('invented_tool'), empty('also_invented')]);
  assert.deepEqual(r.dropped, []);
});

test('an invented empty name does not turn the lone real argless call beside it into a dump', () => {
  // R2 counts the envelope's empties to read its SHAPE, and a name the tool list does not carry is
  // not part of that shape: the guard keeps it (dispatch ignores it) and so must not count it
  // either. Counted, one hallucinated entry beside a legitimate `list_automations{}` would flip R2
  // and silently drop the only thing the turn actually asked for.
  const calls = [empty('invented_tool'), empty(LIST_AUTOMATIONS_TOOL.name)];
  const r = dropSchemaEcho(calls, TOOLS);
  assert.deepEqual(r.kept, calls, 'the real argless request survives the invented name');
  assert.deepEqual(r.dropped, []);
});

test('the kept list keeps the envelope order', () => {
  const a: LlmToolCall = { name: 'set_preference', input: { key: 'agent_tz', value: 'Asia/Jakarta' } };
  const b: LlmToolCall = { name: 'send_reaction', input: { type: 'like' } };
  const c: LlmToolCall = { name: 'update_directives', input: { op: 'add', text: 'keep it short' } };
  const r = dropSchemaEcho([a, empty('recall_memory'), b, empty('update_memory'), c], TOOLS);
  assert.deepEqual(r.kept.map(k => k.name), ['set_preference', 'send_reaction', 'update_directives']);
});

test('an empty envelope and a clean envelope both come back untouched, with nothing dropped', () => {
  assert.deepEqual(dropSchemaEcho([], TOOLS), { kept: [], dropped: [] });
  const clean: LlmToolCall[] = [{ name: 'send_reaction', input: { type: 'laugh' } }];
  assert.deepEqual(dropSchemaEcho(clean, TOOLS), { kept: clean, dropped: [] });
});

test('a missing input object reads as empty — the guard never throws on a malformed call', () => {
  const calls = [{ name: 'list_automations' }, { name: 'cancel_research' }] as unknown as LlmToolCall[];
  const r = dropSchemaEcho(calls, TOOLS);
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped.length, 2);
});
