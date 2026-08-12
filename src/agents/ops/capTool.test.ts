import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capToolEntry, capMessagesChars } from './capTool.js';
import type { LlmMessage } from '../../llm/types.js';

test('capToolEntry passes short entries through untouched', () => {
  const entry = 'TOOL read_email RESULT:\nshort body';
  assert.equal(capToolEntry(entry, 20_000), entry);
});

test('capToolEntry keeps head + tail with a trim marker, bounded near the cap', () => {
  const entry = `TOOL read_email RESULT:\n${'a'.repeat(100_000)}END-OF-THREAD`;
  const capped = capToolEntry(entry, 20_000);
  assert.ok(capped.length < 20_200, `capped length ${capped.length} should be ~20k`);
  assert.ok(capped.startsWith('TOOL read_email RESULT:'), 'keeps the head (query framing)');
  assert.ok(capped.endsWith('END-OF-THREAD'), 'keeps the tail (the conclusion)');
  assert.match(capped, /…\[trimmed \d+ chars\]…/);
});

function toolMsg(chars: number, name = 'search_gmail'): LlmMessage {
  return { role: 'user', content: `TOOL ${name} RESULT:\n${'x'.repeat(chars)}` };
}

test('capMessagesChars evicts oldest tool results first and stops once under the cap', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'the task prompt' },
    { role: 'assistant', content: '(running tools)' },
    toolMsg(60_000, 'oldest'),
    { role: 'assistant', content: '(running tools)' },
    toolMsg(60_000, 'middle'),
    { role: 'assistant', content: '(running tools)' },
    toolMsg(60_000, 'newest'),
  ];
  const evicted = capMessagesChars(messages, 130_000);
  assert.equal(evicted, 1, 'evicting the oldest alone brings it under the cap');
  assert.match(messages[2].content as string, /evicted to keep context bounded/);
  assert.match(messages[4].content as string, /^TOOL middle/, 'newer results untouched');
  assert.match(messages[6].content as string, /^TOOL newest/, 'latest exchange untouched');
});

test('capMessagesChars never touches the task prompt or the latest exchange', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: `the task prompt ${'p'.repeat(50_000)}` },
    { role: 'assistant', content: '(running tools)' },
    toolMsg(200_000, 'latest'),
  ];
  // Way over cap, but index 0 is protected and the tool result sits in the last-two window.
  const evicted = capMessagesChars(messages, 10_000);
  assert.equal(evicted, 0);
  assert.match(messages[0].content as string, /^the task prompt/);
  assert.match(messages[2].content as string, /^TOOL latest/);
});

test('capMessagesChars skips non-tool messages and already-evicted markers', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'the task prompt' },
    { role: 'assistant', content: 'a'.repeat(50_000) }, // assistant text is never evicted
    toolMsg(50_000, 'one'),
    { role: 'assistant', content: '(running tools)' },
    toolMsg(50_000, 'two'),
    { role: 'assistant', content: '(running tools)' },
    toolMsg(10, 'three'),
  ];
  const first = capMessagesChars(messages, 60_000);
  assert.equal(first, 2, 'both eligible tool results evicted');
  // Still over cap (the fat assistant turn remains) — a second pass finds nothing new to evict.
  const second = capMessagesChars(messages, 60_000);
  assert.equal(second, 0);
});

test('capMessagesChars leaves an under-cap array untouched', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'the task prompt' },
    { role: 'assistant', content: '(running tools)' },
    toolMsg(1_000),
    { role: 'assistant', content: 'done' },
  ];
  const before = JSON.stringify(messages);
  assert.equal(capMessagesChars(messages, 300_000), 0);
  assert.equal(JSON.stringify(messages), before);
});
