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

// --- tool_calls fails closed (fix review item 1) ---

test('bubbles before tool_calls: reports not-empty before any sentence, and does not refire', () => {
  const events: string[] = [];
  const s = createEnvelopeStream({
    onToolCalls: e => events.push(`tools:${e}`),
    onSentence: (b, t) => events.push(`${b}:${t}`),
  });
  s.push('{"confidence_level":1,"bubbles":[{"text":"on it. sec"}],"tool_calls":[{"name":"d","args":{}}],"status":{}}');
  s.end();
  assert.deepEqual(events, ['tools:false', '0:on it.', '0:sec']);
});

test('tool_calls as a bare string fails closed', () => {
  const r = run(['{"confidence_level":1,"tool_calls":"[{\\"name\\":\\"delegate\\"}]","bubbles":[{"text":"hi"}],"status":{}}']);
  assert.equal(r.tools, false);
});

test('tool_calls as an object (not an array) fails closed', () => {
  const r = run(['{"confidence_level":1,"tool_calls":{"name":"delegate"},"bubbles":[{"text":"hi"}],"status":{}}']);
  assert.equal(r.tools, false);
});

test('a missing tool_calls key fails closed', () => {
  const r = run(['{"confidence_level":1,"bubbles":[{"text":"hi"}],"status":{}}']);
  assert.equal(r.tools, false);
});

test('duplicate tool_calls keys are sticky-false: once false, never reported true', () => {
  const r = run(['{"tool_calls":null,"tool_calls":[{"name":"d"}],"bubbles":[{"text":"hi"}]}']);
  assert.equal(r.tools, false);
});

// --- end() is terminal (fix review item 2) ---

test('push() after end() is a no-op forever', () => {
  const out: string[] = [];
  const s = createEnvelopeStream({ onSentence: (b, t) => out.push(`${b}:${t}`) });
  s.push('{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"ok. bye');
  s.end();
  const before = out.slice();
  s.push('. more."}]}');
  assert.deepEqual(out, before);
  assert.deepEqual(out, ['0:ok.']);
});

test('push() after end() with no prior push emits nothing', () => {
  const out: string[] = [];
  const s = createEnvelopeStream({ onSentence: (b, t) => out.push(`${b}:${t}`) });
  s.end();
  s.push('{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"late."}]}');
  assert.deepEqual(out, []);
});

// --- abbreviations, titles and list markers don't split (fix review item 3) ---

test('abbreviations, short titles and list markers keep the period glued', () => {
  const cases = ['at 7 a.m. tomorrow', 'e.g. this one', 'mr. smith said', '1. first'];
  for (const text of cases) {
    const r = run(['{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":' + JSON.stringify(text) + '}]}']);
    assert.deepEqual(r.out, [`0:${text}`], text);
  }
});

// --- bare-string bubbles (fix review item 4) ---

test('a bare string directly in bubbles is its own bubble, sentences and onBubbleEnd included', () => {
  const events: string[] = [];
  const s = createEnvelopeStream({
    onSentence: (b, t) => events.push(`${b}:${t}`),
    onBubbleEnd: b => events.push(`E${b}`),
  });
  s.push('{"confidence_level":1,"tool_calls":null,"bubbles":["hi. there", {"text":"two"}]}');
  s.end();
  assert.deepEqual(events, ['0:hi.', '0:there', 'E0', '1:two', 'E1']);
});

// --- ellipsis never splits (fix review item 5) ---

test('an ellipsis, dotted or glyph, never splits the sentence', () => {
  const r1 = run(['{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"wait... what"}]}']);
  assert.deepEqual(r1.out, ['0:wait... what']);
  const r2 = run(['{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"hmm… ok"}]}']);
  assert.deepEqual(r2.out, ['0:hmm… ok']);
});

// --- an emoji run after a boundary stays glued to the sentence before it (fix review item 6) ---

test('an emoji run right after a boundary stays with the preceding sentence', () => {
  const r = run(['{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"done. 😀 next"}]}']);
  assert.deepEqual(r.out, ['0:done. 😀', '0:next']);
});

// --- an invalid \uXXXX escape is dropped, not decoded to a NUL (fix review item 7) ---

test('an invalid unicode escape is dropped rather than decoded as U+0000', () => {
  const r = run(['{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"x\\uZZZZ y."}]}']);
  assert.deepEqual(r.out, ['0:x y.']);
});

// --- onBubbleEnd fires at the text string's close, not the object's (fix review item 8) ---

test('onBubbleEnd fires right after the text string closes, ahead of the rest of the object', () => {
  const events: string[] = [];
  const s = createEnvelopeStream({
    onSentence: (b, t) => events.push(`${b}:${t}`),
    onBubbleEnd: b => events.push(`E${b}`),
  });
  s.push('{"confidence_level":1,"tool_calls":null,"bubbles":[{"text":"hi.","re":"later"}]}');
  s.end();
  assert.deepEqual(events, ['0:hi.', 'E0']);
});
