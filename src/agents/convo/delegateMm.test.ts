// Coverage for the delegate_to_mm handler in processConvoResult: building an MmTask from this-turn
// media, recalling an earlier stashed file (media_scope "earlier"), the honest miss when nothing is
// recallable, and the in-flight dedup. Runs end-to-end against the in-memory DB backend (no Supabase
// creds), with voiceInstant degrading to its static floor when the LLM call fails.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { rememberMedia } from './mediaRecall.js';
import { emptyMedia, type IncomingMedia } from '../../webhook/types.js';
import { markOpsStart, __resetOpsCoordination } from '../../state/opsCoordination.js';
import { isMmTask, type MmTask } from '../types.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegateMm(request: string, opts: { media_scope?: 'this_turn' | 'earlier' } = {}): LlmToolCall {
  return { name: 'delegate_to_mm', input: { request, media_scope: opts.media_scope ?? null, meta_prompt: null, address: null, deal_ref: null } };
}

function delegateOps(request: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'web_research', request, meta_prompt: null } };
}

function withImage(): IncomingMedia {
  return { images: [{ url: 'https://cdn.linqapp.com/x.jpg', mimeType: 'image/jpeg' }], audio: [], video: [], docs: [] };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
};

test('delegate_to_mm with this-turn media builds an MmTask carrying the file', async () => {
  __resetOpsCoordination();
  const a = { ...baseArgs(), media: withImage() };
  const res = makeResult(['one sec, looking at that'], [delegateMm("what's in this photo")]);
  const out = await processConvoResult({ ...a, res, textToSend: "what's this?" });

  assert.ok(out.delegatedTask, 'a task was delegated');
  assert.ok(isMmTask(out.delegatedTask!), 'it is an MM task (kind media_read)');
  const mm = out.delegatedTask as MmTask;
  assert.equal(mm.media.images.length, 1);
  assert.equal(mm.recalledAgeMs, undefined, 'this-turn media is not a recall');
  assert.ok(out.text, 'the holding beat is never silent');
});

test('delegate_to_mm media_scope="earlier" recalls the stashed file with an age', async () => {
  __resetOpsCoordination();
  const a = baseArgs(); // no media this turn
  await rememberMedia(a.handle, a.chatId, withImage()); // an earlier send is stashed
  const res = makeResult(['lemme pull that back up'], [delegateMm('reread the fine print', { media_scope: 'earlier' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'reread the fine print' });

  assert.ok(out.delegatedTask && isMmTask(out.delegatedTask), 'recalled into an MM task');
  const mm = out.delegatedTask as MmTask;
  assert.equal(mm.media.images.length, 1);
  assert.equal(typeof mm.recalledAgeMs, 'number', 'recall framing age is set');
});

test('delegate_to_mm with nothing to recall is an honest miss, no task', async () => {
  __resetOpsCoordination();
  const a = baseArgs(); // no media, nothing stashed
  const res = makeResult([], [delegateMm('that photo from before', { media_scope: 'earlier' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'that photo from before' });

  assert.equal(out.delegatedTask, null, 'no task when there is no file to read');
  assert.ok(out.text, 'the turn still speaks (asks them to resend)');
});

test('two delegations in one turn: first wins deterministically (no silent drop-swap)', async () => {
  __resetOpsCoordination();
  // Model emits MM first, then Ops — MM must win (first-wins guard), not be overwritten by Ops.
  const a = { ...baseArgs(), media: withImage() };
  const out = await processConvoResult({
    ...a,
    res: makeResult(['one sec'], [delegateMm('read this photo'), delegateOps('owner of 412 Maple')]),
    textToSend: 'read this and pull the owner of 412 Maple',
  });
  assert.ok(out.delegatedTask && isMmTask(out.delegatedTask), 'the first delegation (MM) survives');
});

test('two delegations, ops first: ops wins, mm is not overwritten in', async () => {
  __resetOpsCoordination();
  const a = { ...baseArgs(), media: withImage() };
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegateOps('owner of 412 Maple'), delegateMm('read this photo')]),
    textToSend: 'pull the owner of 412 Maple and read this',
  });
  assert.ok(out.delegatedTask, 'a task was delegated');
  assert.equal(isMmTask(out.delegatedTask!), false, 'the first delegation (Ops) survives, not the later MM');
});

test('delegate_to_mm suppresses a duplicate media read already in flight', async () => {
  __resetOpsCoordination();
  const a = { ...baseArgs(), media: withImage() };
  markOpsStart(a.chatId, 'existing', { kind: 'media_read', request: 'read the contract' }, new AbortController());
  const res = makeResult([], [delegateMm('read the contract')]);
  const out = await processConvoResult({ ...a, res, textToSend: 'read the contract' });

  assert.equal(out.delegatedTask, null, 'no second task for the same in-flight read');
  assert.ok(out.text, 'a "still on it" beat still goes out');
});
