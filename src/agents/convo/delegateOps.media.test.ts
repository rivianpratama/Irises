// Coverage for chat media riding a delegate_to_ops: this-turn attachments auto-attach (safety net),
// media_scope "earlier" recalls the 24h stash with an age, an empty recall keeps the delegation but
// prefixes the brief with the honest gone-note, and "none" opts out. Mirrors delegateMm.test.ts —
// in-memory DB backend, no network.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { rememberMedia } from './mediaRecall.js';
import { emptyMedia, type IncomingMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { isMmTask } from '../types.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}

function delegateOps(request: string, opts: { media_scope?: 'this_turn' | 'earlier' | 'none'; meta_prompt?: string } = {}): LlmToolCall {
  return {
    name: 'delegate_to_ops',
    input: { kind: 'general', request, media_scope: opts.media_scope ?? null, meta_prompt: opts.meta_prompt ?? null },
  };
}

function withImage(): IncomingMedia {
  return { images: [{ url: 'https://cdn.example.com/x.jpg', mimeType: 'image/jpeg', attachmentId: 'att1' }], audio: [], video: [], docs: [] };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
};

test('this-turn media auto-attaches to the OpsTask (safety net), no recall framing', async () => {
  __resetOpsCoordination();
  const a = { ...baseArgs(), media: withImage() };
  const res = makeResult(['checking that against the market now'], [delegateOps('is this price fair?')]);
  const out = await processConvoResult({ ...a, res, textToSend: 'is this price fair?' });

  assert.ok(out.delegatedTask, 'a task was delegated');
  assert.equal(isMmTask(out.delegatedTask!), false, 'it is an Ops task, not MM');
  assert.equal(out.delegatedTask!.media?.images.length, 1, 'this-turn file rides the task');
  assert.equal(out.delegatedTask!.recalledAgeMs, undefined);
});

test('media_scope "earlier" recalls the stashed file with an age', async () => {
  __resetOpsCoordination();
  const a = baseArgs(); // no media this turn
  await rememberMedia(a.handle, a.chatId, withImage());
  const res = makeResult(['on it, digging into that clause'], [delegateOps('check the renewal clause on that agreement', { media_scope: 'earlier' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'yes check it' });

  assert.ok(out.delegatedTask && !isMmTask(out.delegatedTask), 'an Ops task');
  assert.equal(out.delegatedTask!.media?.images.length, 1, 'the earlier file rides the task');
  assert.equal(typeof out.delegatedTask!.recalledAgeMs, 'number', 'recall framing age is set');
});

test('media_scope "earlier" with nothing stashed keeps the delegation and notes the gone file in the brief', async () => {
  __resetOpsCoordination();
  const a = baseArgs(); // nothing stashed
  const res = makeResult(['looking into it'], [delegateOps('check the clause', { media_scope: 'earlier', meta_prompt: 'pull the renewal terms' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'check the clause' });

  assert.ok(out.delegatedTask, 'the research still runs without the file');
  assert.equal(out.delegatedTask!.media, undefined);
  assert.match(out.delegatedTask!.metaPrompt ?? '', /no longer retrievable/);
  assert.match(out.delegatedTask!.metaPrompt ?? '', /pull the renewal terms/, 'the model brief survives after the note');
});

test('media_scope "none" opts a file-carrying message out of the attach', async () => {
  __resetOpsCoordination();
  const a = { ...baseArgs(), media: withImage() };
  const res = makeResult(['checking your inbox now'], [delegateOps('did the invoice reply land?', { media_scope: 'none' })]);
  const out = await processConvoResult({ ...a, res, textToSend: "btw here's a flyer. did the invoice reply land?" });

  assert.ok(out.delegatedTask);
  assert.equal(out.delegatedTask!.media, undefined, 'irrelevant file stays off the task');
});

test('no media, no scope: task carries no media and no gone-note', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(['looking that up now'], [delegateOps("what's the return window on a macbook")]);
  const out = await processConvoResult({ ...a, res, textToSend: "what's the return window on a macbook" });

  assert.ok(out.delegatedTask);
  assert.equal(out.delegatedTask!.media, undefined);
  assert.ok(!(out.delegatedTask!.metaPrompt ?? '').includes('no longer retrievable'));
});
