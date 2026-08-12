// Group-scoped fresh identity through the tool-dispatch layer: in a GROUP turn the memory
// handle is the group's own `group:<chatId>` pseudo-handle, so memory verbs (set_preference,
// update_memory) land on the group's shared identity and NEVER on any member's personal rows,
// while per-person facilities (delegate_to_ops → Gmail) stay bound to the sender. Runs
// end-to-end against the in-memory DB backend (no Supabase creds, no LLM calls on this path).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { memoryHandle, groupHandle } from '../../memory/identity.js';
import { getPreference } from '../../db/repositories/memory.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// Minimal engine stub (repo DI convention): captures remember() and accepts reminders.
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
function installStubEngine(): Array<{ chatId: string; handle: string; note: string }> {
  const remembered: Array<{ chatId: string; handle: string; note: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { return { id: 'r1', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember(chatId, handle, note) { remembered.push({ chatId, handle, note }); },
    async probe() { return { ok: true }; },
    async channelSend() { /* noop */ },
  };
  resetEngineBackendCache(engine);
  return remembered;
}


function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function freshHandle(): string {
  return `+1555400${(seq++).toString().padStart(4, '0')}`;
}

// Mirrors convo/client.ts: handle = memoryHandle(chatContext, chatId) — the group turn's
// memory identity is the pseudo-handle, the 1:1 turn's is the sender.
function args(isGroup: boolean) {
  const sender = freshHandle();
  const chatId = randomUUID();
  const chatContext: ChatContext = {
    isGroupChat: isGroup,
    participantNames: isGroup ? [sender, freshHandle()] : [],
    chatName: null,
    senderHandle: sender,
  };
  return { chatId, handle: memoryHandle(chatContext, chatId)!, chatContext, history: [], media: emptyMedia() };
}

test('group set_preference lands on the GROUP identity, never the sender', async () => {
  __resetOpsCoordination();
  const a = args(true);
  const res = makeResult(['you got it'], [{ name: 'set_preference', input: { key: 'address_as', value: 'the A-team' } }]);
  await processConvoResult({ ...a, res, textToSend: 'call us the A-team' });

  assert.equal(await getPreference(groupHandle(a.chatId), 'address_as'), 'the A-team');
  assert.equal(await getPreference(a.chatContext.senderHandle!, 'address_as'), undefined, "sender's personal prefs untouched");
});

test('group update_memory forwards to the engine under the GROUP identity', async () => {
  __resetOpsCoordination();
  const remembered = installStubEngine();
  try {
    const a = args(true);
    const res = makeResult(['noted'], [{ name: 'update_memory', input: { request: 'the group prefers evening updates', meta_prompt: null } }]);
    await processConvoResult({ ...a, res, textToSend: 'we all prefer evening updates' });
    await new Promise(r => setTimeout(r, 10)); // fire-and-forget beat
    assert.equal(remembered.length, 1, 'the note reached the engine');
    assert.equal(remembered[0].handle, groupHandle(a.chatId), 'curation targets the group identity');
    assert.equal(remembered[0].chatId, a.chatId);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('group delegate_to_ops stays bound to the SENDER (per-person Gmail/inbox access)', async () => {
  __resetOpsCoordination();
  const a = args(true);
  const res = makeResult(['on it'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: 'whats due this week', meta_prompt: null } }]);
  const out = await processConvoResult({ ...a, res, textToSend: 'whats due this week' });

  assert.equal(out.delegatedTask?.agentHandle, a.chatContext.senderHandle, 'Ops runs as the person, not the pseudo-handle');
});

test('a 1:1 turn is unchanged: memory verbs land on the sender', async () => {
  __resetOpsCoordination();
  const a = args(false);
  assert.equal(a.handle, a.chatContext.senderHandle, 'memory identity IS the sender in a 1:1');
  const res = makeResult(['done'], [{ name: 'set_preference', input: { key: 'address_as', value: 'Ace' } }]);
  await processConvoResult({ ...a, res, textToSend: 'call me Ace' });

  assert.equal(await getPreference(a.chatContext.senderHandle!, 'address_as'), 'Ace');
  assert.equal(await getPreference(groupHandle(a.chatId), 'address_as'), undefined, 'no stray group row');
});
