import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchServerToolInputs } from './callLLM.js';

// SDK 0.39's stream accumulator applies input_json_delta only to 'tool_use' blocks, so
// server_tool_use (web_search) inputs stream in but never land on the final message — and the
// pause_turn echo must be verbatim. patchServerToolInputs restores them from our raw buffers.

test('restores a server_tool_use input the SDK accumulator dropped', () => {
  const content = [
    { type: 'text', input: undefined },
    { type: 'server_tool_use', input: {} },
  ];
  const bufs = new Map([[1, '{"query":"train timetable to the coast"}']]);
  patchServerToolInputs(content, bufs);
  assert.deepEqual(content[1].input, { query: 'train timetable to the coast' });
});

test('never touches client tool_use blocks (the SDK already accumulated those)', () => {
  const content = [{ type: 'tool_use', input: { already: 'accumulated' } }];
  patchServerToolInputs(content, new Map([[0, '{"clobber":"me"}']]));
  assert.deepEqual(content[0].input, { already: 'accumulated' });
});

test('tolerates empty buffers, out-of-range indexes, and partial JSON', () => {
  const content: Array<{ type: string; input?: unknown }> = [
    { type: 'server_tool_use', input: { keep: true } },
  ];
  patchServerToolInputs(content, new Map([[0, ''], [5, '{"x":1}'], [0, '{"broken']]));
  assert.deepEqual(content[0].input, { keep: true }, 'partial JSON leaves the SDK snapshot alone');
});
