// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
// The shared Composer call, with the LLM injected (repo convention: DI, no module mocks). What's
// under test is the ASSEMBLY both callers depend on: the instruction inside <prompt>, the format
// anchor as the very last thing the model reads, the JSON envelope bridged to legacy bubble text,
// the echo tripwire firing only when there IS a line already on their screen, and the throw that
// hands the degrade decision back to the caller.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeWithComposer, FORMAT_ANCHOR } from './composerCore.js';
import { addMessage } from '../db/repositories/conversations.js';
import { resetStorageForTests } from '../db/sqlite.js';
import type { LlmRequest, LlmResult } from '../llm/types.js';

function fakeLlm(text: string, captured: LlmRequest[] = []) {
  return (async (req: LlmRequest): Promise<LlmResult> => {
    captured.push(req);
    return { text, provider: 'anthropic', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } } as unknown as LlmResult;
  }) as never;
}

const base = {
  chatId: 'web:a',
  handle: '',
  trace: { chatId: 'web:a', handle: '', label: 'composer-test' },
};

beforeEach(() => resetStorageForTests());

test('the JSON envelope becomes legacy bubble text; the instruction rides inside <prompt>', async () => {
  const captured: LlmRequest[] = [];
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"deadline\'s march 14"},{"text":"you\'ve got time"}],"confidence_level":90}', captured),
  });
  assert.equal(out, "deadline's march 14\n---\nyou've got time");
  const last = captured[0].messages.at(-1)!;
  assert.match(String(last.content), /<prompt>[\s\S]*the deadline is march 14[\s\S]*<\/prompt>/);
  assert.equal(captured[0].jsonBubbles, true);
  assert.ok(captured[0].system, 'the composer persona is the system prompt');
});

test('the format anchor is the LAST thing in the message (recency holds the split rule)', async () => {
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  assert.ok(String(captured[0].messages.at(-1)!.content).endsWith(FORMAT_ANCHOR));
});

test('buildInstruction receives the fetched history, and the voice window is the last 10 turns', async () => {
  for (let i = 0; i < 12; i++) await addMessage('web:a', 'user', `m${i}`, '+1555');
  const captured: LlmRequest[] = [];
  let seen = 0;
  await composeWithComposer({
    ...base,
    buildInstruction: history => { seen = history.length; return 'x'; },
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  assert.equal(seen, 12, 'the callback sees the FULL history, not the sliced window');
  assert.equal(captured[0].messages.length, 11, '10 history turns + the brief');
  assert.equal(String(captured[0].messages[0].content), 'm2');
});

test('an echoed holding line is stripped — but only when a holding line was given', async () => {
  const envelope = '{"bubbles":[{"text":"checking your inbox nownothing under amazon in there"}]}';
  const stripped = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    holdingText: 'checking your inbox now',
    llm: fakeLlm(envelope),
  });
  assert.equal(stripped, 'nothing under amazon in there');

  const untouched = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm(envelope),
  });
  assert.equal(untouched, 'checking your inbox nownothing under amazon in there');
});

test('a stray [[re:N]] tag never reaches the send path', async () => {
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm('{"bubbles":[{"text":"[[re:2]] got it"}]}'),
  });
  assert.equal(out, 'got it');
});

test('an empty reply retries once, then the second success is used', async () => {
  let n = 0;
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: (async () => {
      n++;
      return { text: n === 1 ? '' : '{"bubbles":[{"text":"second time"}]}' } as unknown as LlmResult;
    }) as never,
  });
  assert.equal(out, 'second time');
  assert.equal(n, 2);
});

test('two failed attempts throw — the caller owns the degrade', async () => {
  let n = 0;
  await assert.rejects(
    composeWithComposer({
      ...base,
      buildInstruction: () => 'x',
      errorDetail: { moment: 'answer' },
      llm: (async () => { n++; throw new Error('provider down'); }) as never,
    }),
    /provider down/,
  );
  assert.equal(n, 2, 'exactly one retry, then it gives up');
});

test('two empty replies throw too (an empty completion is a failure, not a message)', async () => {
  await assert.rejects(
    composeWithComposer({ ...base, buildInstruction: () => 'x', llm: fakeLlm('') }),
    /no text/,
  );
});
