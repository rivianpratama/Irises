// Coverage for the remember_user target-handle guard: the ONE write on a live turn whose key
// the MODEL chooses. Unvalidated it is a cross-user memory write (user_profiles.name is an
// addressing source in every later prompt for the victim). The guard: 1:1 allows only the
// sender; a group chat also allows a listed participant; anything else is DROPPED (never
// redirected to the sender — the model asserted whose info it is). Runs end-to-end against
// the in-memory DB backend (no Supabase creds, no LLM calls on this path).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getUserProfile } from '../../db/repositories/profiles.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function rememberUser(input: { handle?: string; name?: string; fact?: string }): LlmToolCall {
  return { name: 'remember_user', input };
}

let seq = 0;
function freshHandle(): string {
  return `+1555${String(1000000 + seq++).slice(-7)}${Math.floor(Math.random() * 900 + 100)}`;
}

function args(over: Partial<ChatContext> = {}) {
  const sender = freshHandle();
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender, ...over };
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
}

test('no handle arg → writes the SENDER profile', async () => {
  __resetOpsCoordination();
  const a = args();
  const res = makeResult(['nice to meet you, jo!'], [rememberUser({ name: 'Jo' })]);
  const out = await processConvoResult({ ...a, res, textToSend: "i'm jo btw" });
  assert.equal(out.rememberedUser?.name, 'Jo');
  assert.equal(out.rememberedUser?.isForSender, true);
  assert.equal((await getUserProfile(a.handle))?.name, 'Jo');
});

test('explicit sender handle → allowed, same as omitting it', async () => {
  __resetOpsCoordination();
  const a = args();
  const res = makeResult(['got it'], [rememberUser({ handle: a.handle, fact: 'studying for a certification exam' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'grinding for my cert exam' });
  assert.equal(out.rememberedUser?.fact, 'studying for a certification exam');
  assert.deepEqual((await getUserProfile(a.handle))?.facts, ['studying for a certification exam']);
});

test('1:1 chat: a FOREIGN handle is ignored — no write, no rememberedUser', async () => {
  __resetOpsCoordination();
  const victim = freshHandle();
  const a = args();
  const res = makeResult(['sure'], [rememberUser({ handle: victim, name: 'Chief' })]);
  const out = await processConvoResult({ ...a, res, textToSend: `my buddy at ${victim} goes by chief` });
  assert.equal(out.rememberedUser, null, 'no confirmation for a dropped write');
  assert.equal(await getUserProfile(victim), null, 'victim profile row was never created');
  assert.equal((await getUserProfile(a.handle))?.name ?? null, null, 'not redirected onto the sender either');
});

test('group chat: a LISTED PARTICIPANT is a valid target (isForSender false)', async () => {
  __resetOpsCoordination();
  const participant = freshHandle();
  const a = args({ isGroupChat: true });
  a.chatContext.participantNames = [a.handle, participant, '+15550009999'];
  const res = makeResult(['noted'], [rememberUser({ handle: participant, name: 'Sam' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'that was sam talking' });
  assert.equal(out.rememberedUser?.name, 'Sam');
  assert.equal(out.rememberedUser?.isForSender, false);
  assert.equal((await getUserProfile(participant))?.name, 'Sam');
});

test('group chat: a NON-participant handle is ignored', async () => {
  __resetOpsCoordination();
  const outsider = freshHandle();
  const a = args({ isGroupChat: true });
  a.chatContext.participantNames = [a.handle, freshHandle()];
  const res = makeResult(['ok'], [rememberUser({ handle: outsider, name: 'Mallory' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'remember mallory' });
  assert.equal(out.rememberedUser, null);
  assert.equal(await getUserProfile(outsider), null);
});

test('1:1 chat: participantNames can NOT authorize a foreign write (group-only allowance)', async () => {
  __resetOpsCoordination();
  const other = freshHandle();
  const a = args(); // isGroupChat: false
  a.chatContext.participantNames = [a.handle, other]; // roster present but this is a 1:1
  const res = makeResult(['ok'], [rememberUser({ handle: other, name: 'Rex' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'save that' });
  assert.equal(out.rememberedUser, null);
  assert.equal(await getUserProfile(other), null);
});
