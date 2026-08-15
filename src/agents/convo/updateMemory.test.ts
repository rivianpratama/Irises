// Coverage for the update_memory (Convo → engine memory) forwarding path: the tool call forwards
// the note to the configured engine's remember() (the engine owns the long-term user model now),
// it never occupies the one-per-turn delegatedTask slot so it coexists with a research delegation
// in the same reply, and the JSON envelope schema actually offers the tool. Runs end-to-end
// against the in-memory DB backend with a stubbed EngineBackend (repo DI convention).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
import { buildEnvelopeSchema } from '../../pipeline/bubbleJson.js';
import { UPDATE_MEMORY_TOOL, DELEGATE_TO_OPS_TOOL } from './tools.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function updateMemory(request: string, metaPrompt?: string): LlmToolCall {
  return { name: 'update_memory', input: { request, meta_prompt: metaPrompt ?? null } };
}

function delegateOps(request: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'web_research', request, meta_prompt: null } };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
};

/** Stub engine capturing remember() calls — swapped in via resetEngineBackendCache (DI). */
function stubEngine(): { engine: EngineBackend; remembered: Array<{ chatId: string; handle: string; note: string }> } {
  const remembered: Array<{ chatId: string; handle: string; note: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { throw new Error('not under test'); },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember(chatId, handle, note) { remembered.push({ chatId, handle, note }); },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  return { engine, remembered };
}

test('update_memory forwards the note to the engine, never the delegation slot', async () => {
  __resetOpsCoordination();
  const { engine, remembered } = stubEngine();
  resetEngineBackendCache(engine);
  try {
    const a = baseArgs();
    const res = makeResult(['got it, fixed my notes'], [updateMemory('they moved from KW to eXp')]);
    const out = await processConvoResult({ ...a, res, textToSend: "actually i left keller williams, i'm at eXp now" });

    // remember() is fire-and-forget — give the microtask a beat to land.
    await new Promise(r => setTimeout(r, 10));
    assert.equal(remembered.length, 1, 'the note reached the engine');
    assert.equal(remembered[0].note, 'they moved from KW to eXp');
    assert.equal(remembered[0].chatId, a.chatId);
    assert.equal(remembered[0].handle, a.handle);
    assert.equal(out.delegatedTask, null, 'the one-per-turn delegation slot stays free');
    assert.ok(out.text, "Convo's own reply is the whole conversation (no follow-up will come)");
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('update_memory coexists with a research delegation in the SAME reply', async () => {
  __resetOpsCoordination();
  const { engine, remembered } = stubEngine();
  resetEngineBackendCache(engine);
  try {
    const a = baseArgs();
    const res = makeResult(
      ['updating that', 'and looking that up now'],
      [updateMemory('job changed to Acme'), delegateOps('latest on the Acme merger')],
    );
    const out = await processConvoResult({ ...a, res, textToSend: "i'm at Acme now btw — what's the latest on the merger?" });

    await new Promise(r => setTimeout(r, 10));
    assert.equal(remembered.length, 1, 'memory note forwarded');
    assert.ok(out.delegatedTask, 'research delegation ran too');
    assert.equal(out.delegatedTask!.kind, 'web_research');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('update_memory with no engine configured is a safe no-op (turn still replies)', async () => {
  __resetOpsCoordination();
  resetEngineBackendCache(null);
  try {
    const a = baseArgs();
    const res = makeResult(['noted'], [updateMemory('a fact with nowhere to go')]);
    const out = await processConvoResult({ ...a, res, textToSend: 'remember this' });
    assert.ok(out.text, 'the reply still ships');
    assert.equal(out.delegatedTask, null);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('the JSON envelope schema offers update_memory when the tool is in the set', () => {
  const schema = JSON.stringify(buildEnvelopeSchema([DELEGATE_TO_OPS_TOOL, UPDATE_MEMORY_TOOL]));
  assert.ok(schema.includes('"update_memory"'), 'tool name is in the envelope enum');
  assert.ok(schema.includes('meta_prompt'), 'its args are in the flat union');
});
