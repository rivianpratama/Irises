// Coverage for the update_memory (Convo → Reflexion) delegation path: the tool call becomes a
// ReflexionTask on the SEPARATE reflexionTask result field (never the one-per-turn delegatedTask
// slot), it coexists with a research delegation in the same reply, duplicates in one reply
// collapse to the first, and the JSON envelope schema actually offers the tool. Runs end-to-end
// against the in-memory DB backend (no Supabase creds, no LLM calls on this path).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { isReflexionTask } from '../types.js';
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

test('update_memory builds a ReflexionTask on its own result field, not the delegation slot', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(['got it, fixed my notes'], [updateMemory('they moved from KW to eXp', 'supersede the brokerage fact; they said "i left keller williams" verbatim')]);
  const out = await processConvoResult({ ...a, res, textToSend: "actually i left keller williams, i'm at eXp now" });

  assert.ok(out.reflexionTask, 'a reflexion task was built');
  assert.ok(isReflexionTask(out.reflexionTask!), 'it narrows via isReflexionTask');
  assert.equal(out.reflexionTask!.trigger, 'delegated');
  assert.equal(out.reflexionTask!.agentHandle, a.handle);
  assert.equal(out.reflexionTask!.chatId, a.chatId);
  assert.equal(out.reflexionTask!.request, 'they moved from KW to eXp');
  assert.match(out.reflexionTask!.focus!, /supersede the brokerage fact/);
  assert.equal(out.delegatedTask, null, 'the one-per-turn delegation slot stays free');
  assert.ok(out.text, "Convo's own reply is the whole conversation (no follow-up will come)");
});

test('update_memory coexists with a research delegation in the SAME reply', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(
    ['updating that', 'and looking that up now'],
    [updateMemory('job changed to Acme'), delegateOps('latest on the Acme merger')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "i'm at Acme now btw — what's the latest on the merger?" });

  assert.ok(out.reflexionTask, 'memory update ran');
  assert.ok(out.delegatedTask, 'research delegation ran too');
  assert.equal(out.delegatedTask!.kind, 'web_research');
});

test('a duplicate update_memory in one reply is a no-op (first wins)', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(['on it'], [updateMemory('first ask'), updateMemory('second ask')]);
  const out = await processConvoResult({ ...a, res, textToSend: 'clean up my notes' });
  assert.equal(out.reflexionTask!.request, 'first ask');
});

test('the JSON envelope schema offers update_memory when the tool is in the set', () => {
  const schema = JSON.stringify(buildEnvelopeSchema([DELEGATE_TO_OPS_TOOL, UPDATE_MEMORY_TOOL]));
  assert.ok(schema.includes('"update_memory"'), 'tool name is in the envelope enum');
  assert.ok(schema.includes('meta_prompt'), 'its args are in the flat union');
});
