// Coverage for recall_memory — the archive search tool and its ONE bounded second pass. Convo is
// single-shot (toolsViaJson: a tool call never returns its result in the same call), so the tool is
// worthless without a second model call; that call is what these tests pin, along with the three
// bounds on it (recall_memory stripped from the second call's tools, the archivePass recursion
// fence, delegation winning on conflict) and the never-silent fallback when it can't run.
// Runs end-to-end against the ephemeral DB backend with the LLM injected (repo DI convention).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, renderArchiveRecallPass, type ChatContext, type ConvoTurnContext } from './shared.js';
import { RECALL_MEMORY_TOOL, DELEGATE_TO_OPS_TOOL, REACTION_TOOL } from './tools.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { archiveEntries, purgeArchiveFor } from '../../db/repositories/memoryArchive.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function recall(query: string): LlmToolCall {
  return { name: 'recall_memory', input: { query } };
}

let seq = 0;
function freshHandle(): string {
  return `+1555500${(seq++).toString().padStart(4, '0')}`;
}

/** The turn context client.ts hands processConvoResult, with the model call injected. */
function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: 'what was that fence guy called again?' }],
    tools: [REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL],
    call,
  };
}

function args(over: Partial<ChatContext> = {}) {
  __resetOpsCoordination();
  const sender = freshHandle();
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender, ...over };
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend: 'what was that fence guy called again?',
  };
}

async function seedArchive(handle: string, chatId: string): Promise<void> {
  await archiveEntries([{
    source: 'message_pruned', agentHandle: handle, chatId,
    content: 'the fence guy was Ruiz Fencing, quoted 3200 for the back run',
    createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
  }]);
}

test('recall_memory runs the search and answers from a SECOND pass with the tool stripped', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);

  const seen: LlmRequest[] = [];
  const res = makeResult(['hmm, let me think'], [recall('fence guy')]);
  const out = await processConvoResult({
    ...a,
    res,
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(['ruiz fencing, 3200 for the back run'], []);
    }),
  });

  assert.equal(seen.length, 1, 'exactly one second pass');
  const second = seen[0];
  assert.equal(second.system, 'SYSTEM PROMPT (persona + this turn)', 'same system prompt (cache-friendly)');
  assert.ok(!second.tools?.some(t => t.name === 'recall_memory'), 'recall_memory is STRIPPED — the pass cannot loop');
  assert.ok(second.tools?.some(t => t.name === 'delegate_to_ops'), 'the other tools still stand');

  // The hits ride in as the final user-role message, data-tagged.
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.role, 'user');
  const text = String(last.content);
  assert.match(text, /<memory_archive_results>/);
  assert.match(text, /Ruiz Fencing/);
  assert.match(text, /archived, possibly superseded/);
  assert.match(text, /"fence guy"/);

  // The first pass's draft is discarded; what ships is the answer written WITH the snippets.
  assert.equal(out.text, 'ruiz fencing, 3200 for the back run');
  await purgeArchiveFor({ handle: a.handle });
});

test('an empty archive still gets a second pass, told to answer honestly', async () => {
  const a = args();
  const seen: LlmRequest[] = [];
  const out = await processConvoResult({
    ...a,
    res: makeResult(['one sec'], [recall('the hendersons')]),
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(["i don't have that one, remind me?"], []);
    }),
  });
  const text = String(seen[0].messages[seen[0].messages.length - 1].content);
  assert.ok(!text.includes('<memory_archive_results>'), 'no data tag when there is no data');
  assert.match(text, /Nothing in your archive matched/);
  assert.match(text, /Do NOT invent a memory/);
  assert.equal(out.text, "i don't have that one, remind me?");
});

test('only the FIRST recall query in a turn runs', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);
  const seen: LlmRequest[] = [];
  await processConvoResult({
    ...a,
    res: makeResult(['thinking'], [recall('fence guy'), recall('something else entirely')]),
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(['ruiz fencing'], []);
    }),
  });
  assert.equal(seen.length, 1);
  assert.match(String(seen[0].messages[seen[0].messages.length - 1].content), /"fence guy"/);
  await purgeArchiveFor({ handle: a.handle });
});

test('the second pass cannot recurse: a recall call in ITS reply is ignored', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);
  let calls = 0;
  const out = await processConvoResult({
    ...a,
    res: makeResult(['hmm'], [recall('fence guy')]),
    turn: turnCtx(async () => {
      calls++;
      // A model that ignores the stripped tool list and asks again gets nowhere.
      return makeResult(['ruiz fencing, i think'], [recall('fence guy again')]);
    }),
  });
  assert.equal(calls, 1, 'depth is bounded at 2 calls total');
  assert.equal(out.text, 'ruiz fencing, i think');
  await purgeArchiveFor({ handle: a.handle });
});

test('DELEGATION WINS: a turn that also delegates skips the recall pass entirely', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);
  let calls = 0;
  const out = await processConvoResult({
    ...a,
    res: makeResult(['checking that now'], [
      recall('fence guy'),
      { name: 'delegate_to_ops', input: { kind: 'web_research', request: 'current fence prices', meta_prompt: null } },
    ]),
    turn: turnCtx(async () => { calls++; return makeResult(['unused'], []); }),
  });
  assert.equal(calls, 0, 'no second pass — the composer is already coming with grounded facts');
  assert.ok(out.delegatedTask, 'the delegation stands');
  assert.equal(out.text, 'checking that now');
  await purgeArchiveFor({ handle: a.handle });
});

test('a failed second pass falls back to a voiced outcome — never a silent turn', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['let me see'], [recall('fence guy')]),
    turn: turnCtx(async () => { throw new Error('provider down'); }),
  });
  assert.ok(out.text, 'the turn still says something');
  // What it found is relayed verbatim as outcome `facts`, so the answer isn't lost with the call.
  assert.match(out.text!, /Ruiz Fencing/);
  await purgeArchiveFor({ handle: a.handle });
});

test('with no turn context at all, an empty search still voices an honest miss', async () => {
  const a = args();
  const out = await processConvoResult({
    ...a,
    res: makeResult(['hmm'], [recall('a thing i never knew')]),
  });
  assert.ok(out.text);
  assert.notEqual(out.text, 'hmm', 'the nothing_found correction REPLACES the optimistic draft');
});

test('an action-bearing turn keeps its own assembly (the confirmation is not discarded)', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);
  let calls = 0;
  const out = await processConvoResult({
    ...a,
    // list_automations produces an outcome the second pass would know nothing about.
    res: makeResult(['one sec'], [recall('fence guy'), { name: 'list_automations', input: {} }]),
    turn: turnCtx(async () => { calls++; return makeResult(['unused'], []); }),
  });
  assert.equal(calls, 0, 'no recursion — the action outcome would have been dropped');
  assert.ok(out.text);
  await purgeArchiveFor({ handle: a.handle });
});

test('renderArchiveRecallPass labels each hit with its source and age', () => {
  const now = Date.UTC(2026, 0, 20);
  const text = renderArchiveRecallPass('gate code', [{
    entry: {
      id: 1, agentHandle: '+15550001111', source: 'medium_retracted', request: 'gate',
      content: 'the gate code is 4421', meta: {},
      createdAt: now - 3 * 24 * 60 * 60 * 1000, archivedAt: now,
    },
    score: 1,
    snippet: 'the gate code is 4421',
  }], now);
  assert.match(text, /\[medium_retracted, 3 days ago\] gate — the gate code is 4421/);
  assert.match(text, /never present a stale detail as current/);
});
