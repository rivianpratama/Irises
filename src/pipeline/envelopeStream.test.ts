import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelopeStream } from './envelopeStream.js';

function run(chunks: string[]) {
  const out: string[] = []; let tools: boolean | null = null;
  const s = createEnvelopeStream({
    onToolCalls: e => { tools = e; },
    onSentence: (b, t) => out.push(`${b}:${t}`),
  });
  for (const c of chunks) s.push(c);
  s.end();
  return { out, tools };
}

test('null tool_calls then two bubbles, split mid-token', () => {
  const env = '{"confidence_level":85,"tool_calls":null,"bubbles":[{"text":"408","re":null},{"text":"easy one. next?","re":null}],"status":{"mood":"x"}}';
  const r = run(env.match(/.{1,7}/g)!);
  assert.equal(r.tools, true);
  assert.deepEqual(r.out, ['0:408', '1:easy one.', '1:next?']);
});

test('populated tool_calls reports not-empty before any sentence', () => {
  const events: string[] = [];
  const s = createEnvelopeStream({ onToolCalls: e => events.push(`tools:${e}`), onSentence: (_b, t) => events.push(t) });
  s.push('{"confidence_level":70,"tool_calls":[{"name":"delegate_to_ops","args":{"kind":"web_research","request":"a \\"b\\" c"}}],"bubbles":[{"text":"hmm","re":null}],"status":{}}');
  s.end();
  assert.deepEqual(events, ['tools:false', 'hmm']);
});

test('escapes, newline boundary, decimals, split unicode escape', () => {
  const r = run(['{"confidence_level":90,"tool_calls":[],"bubbles":[{"text":"it\'s 3.5 ', 'bucks\\nthen \\u00', 'e9 done","re":null}],"status":{}}']);
  assert.equal(r.tools, true);
  assert.deepEqual(r.out, ['0:it\'s 3.5 bucks', '0:then é done']);
});

test('a string cut off mid-stream emits nothing partial', () => {
  const r = run(['{"confidence_level":90,"tool_calls":null,"bubbles":[{"text":"first. sec']);
  assert.deepEqual(r.out, ['0:first.']);
});

test('text key inside status or tool args is never emitted', () => {
  const r = run(['{"confidence_level":1,"tool_calls":[{"name":"x","args":{"text":"nope."}}],"bubbles":[],"status":{"text":"nope."}}']);
  assert.deepEqual(r.out, []);
});

test('whitespace/newlines between tokens, and split across every single character', () => {
  const env = '{\n  "confidence_level": 42,\n  "tool_calls": null,\n  "bubbles": [\n    {"text": "one. two.", "re": null}\n  ],\n  "status": {}\n}';
  const r = run(env.split(''));
  assert.equal(r.tools, true);
  assert.deepEqual(r.out, ['0:one.', '0:two.']);
});

test('re key before text key inside a bubble object still emits', () => {
  const r = run(['{"confidence_level":5,"tool_calls":[],"bubbles":[{"re":null,"text":"hi there."}],"status":{}}']);
  assert.deepEqual(r.out, ['0:hi there.']);
});
