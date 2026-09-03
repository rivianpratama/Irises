// Coverage for recall_memory — the archive search tool and its ONE bounded second pass. Convo is
// single-shot (toolsViaJson: a tool call never returns its result in the same call), so the tool is
// worthless without a second model call; that call is what these tests pin, along with the three
// bounds on it (recall_memory stripped from the second call's tools, the archivePass recursion
// fence, delegation winning on conflict) and the never-silent fallback when it can't run.
// Runs end-to-end against the ephemeral DB backend with the LLM injected (repo DI convention).

process.env.DATA_BACKEND = 'memory';
// Pin the vector store's notion of "current" so the fake embedder below writes current vectors.
process.env.EMBEDDINGS_MODEL = 'test/fake-embed';
process.env.EMBEDDINGS_DIMENSIONS = '64';
// The hybrid path needs the flag as well as a registered embedder (the backend is resolved from
// both, at call time). No key is set and only the fake embedder below is ever registered.
process.env.MEMORY_SEMANTIC_RECALL = 'on';
// Query expansion defaults ON in production, and it dispatches a REAL classify call when nothing is
// injected. Pinned off for the file so no test here can reach a provider on a machine that happens
// to have keys exported; the expansion section at the bottom turns it on around its own fake lane.
process.env.MEMORY_RECALL_EXPANSION = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, renderArchiveRecallPass, convoPersonaChars, type ChatContext, type ConvoTurnContext } from './shared.js';
import { RECALL_MEMORY_TOOL, DELEGATE_TO_OPS_TOOL, REACTION_TOOL } from './tools.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { archiveEntries, purgeArchiveFor, searchArchive } from '../../db/repositories/memoryArchive.js';
import {
  setArchiveEmbedder, backfillArchiveEmbeddings, l2Normalize, type Embedder,
} from '../../db/repositories/memoryArchiveVectors.js';
import { __setRecallExpansionLlmForTests } from '../../memory/recallExpansion.js';
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

test("the second pass reuses the turn's cache breakpoints instead of re-billing the persona", async () => {
  // It re-sends the SAME system string, so the offsets that split it are still valid — and this is
  // the call where a cache READ is worth the most, since the first pass just wrote it.
  const a = args();
  await seedArchive(a.handle, a.chatId);
  const seen: LlmRequest[] = [];
  const capture = async (req: LlmRequest) => { seen.push(req); return makeResult(['ruiz fencing'], []); };

  await processConvoResult({
    ...a, res: makeResult(['hmm'], [recall('fence guy')]),
    turn: { ...turnCtx(capture), cacheBreakpoints: [12, 40] },
  });
  assert.deepEqual(seen[0].systemCacheBreakpoints, [12, 40], 'both offsets, in order');

  // A caller that declares none gets what this call passed before there was a second breakpoint:
  // the persona head alone.
  seen.length = 0;
  await processConvoResult({ ...a, res: makeResult(['hmm'], [recall('fence guy')]), turn: turnCtx(capture) });
  assert.deepEqual(seen[0].systemCacheBreakpoints, [convoPersonaChars()]);
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

// ── Semantic recall on ──────────────────────────────────────────────────────
// The tool's contract must not shift when the search underneath it gains a vector leg: same one
// second pass, same stripped tool, same data tag. What DOES change is what the search can find.
//
// The fake embedder is duplicated here rather than imported from the repository's own tests: a
// shared test fixture is a coupling between two suites that must be free to diverge.

const DIMS = 64;
const FIXTURES = new Map<string, Float32Array>();

function basis(i: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
}
/** A unit vector at cosine `wa` from `a` (given a ⟂ b, both unit). */
function mix(a: Float32Array, b: Float32Array, wa: number): Float32Array {
  const v = new Float32Array(DIMS);
  const wb = Math.sqrt(1 - wa * wa);
  for (let i = 0; i < DIMS; i++) v[i] = a[i] * wa + b[i] * wb;
  return l2Normalize(v);
}
function bagOfWords(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  return l2Normalize(v);
}
const fakeEmbedder: Embedder = async (texts) => texts.map(t => FIXTURES.get(t) ?? bagOfWords(t));

const FENCE = 'the fence guy was Ruiz Fencing, quoted 3200 for the back run';
FIXTURES.set(FENCE, basis(5));
// A question about the same thing, sharing not one word with it.
FIXTURES.set('who put up that boundary railing', mix(basis(5), basis(9), 0.99));

async function withSemanticRecall(fn: () => Promise<void>): Promise<void> {
  setArchiveEmbedder(fakeEmbedder);
  try {
    await fn();
  } finally {
    setArchiveEmbedder(null);
  }
}

test('semantic on: the second-pass contract is unchanged', async () => {
  const a = args();
  await withSemanticRecall(async () => {
    await seedArchive(a.handle, a.chatId);
    await backfillArchiveEmbeddings({ batchSize: 20, maxBatches: 2 });

    const seen: LlmRequest[] = [];
    const out = await processConvoResult({
      ...a,
      res: makeResult(['hmm, let me think'], [recall('fence guy')]),
      turn: turnCtx(async req => {
        seen.push(req);
        return makeResult(['ruiz fencing, 3200 for the back run'], []);
      }),
    });

    assert.equal(seen.length, 1, 'still exactly one second pass');
    const second = seen[0];
    assert.ok(!second.tools?.some(t => t.name === 'recall_memory'), 'recall_memory is still STRIPPED');
    const text = String(second.messages[second.messages.length - 1].content);
    assert.match(text, /<memory_archive_results>/);
    assert.match(text, /Ruiz Fencing/);
    assert.equal(out.text, 'ruiz fencing, 3200 for the back run', 'the first draft is still discarded');
  });
  await purgeArchiveFor({ handle: a.handle });
});

test('semantic on: a paraphrased reference is answered from a hit lexical search would miss', async () => {
  const a = args();
  await withSemanticRecall(async () => {
    await seedArchive(a.handle, a.chatId);
    await backfillArchiveEmbeddings({ batchSize: 20, maxBatches: 2 });

    const seen: LlmRequest[] = [];
    const out = await processConvoResult({
      ...a,
      res: makeResult(['one sec'], [recall('who put up that boundary railing')]),
      turn: turnCtx(async req => {
        seen.push(req);
        return makeResult(['ruiz fencing did it'], []);
      }),
    });
    assert.equal(seen.length, 1);
    const text = String(seen[0].messages[seen[0].messages.length - 1].content);
    assert.match(text, /<memory_archive_results>/, 'the pass got DATA, not the honest-miss prompt');
    assert.match(text, /Ruiz Fencing/);
    assert.equal(out.text, 'ruiz fencing did it');
  });

  // With no embedder, the very same query reaches nothing: not one of its words is in the memory.
  assert.deepEqual(
    await searchArchive({ query: 'who put up that boundary railing', handle: a.handle, chatId: a.chatId }),
    [],
  );
  await purgeArchiveFor({ handle: a.handle });
});

// ── No embeddings lane: the query-expansion fallback ────────────────────────
// The install this exists for: an Anthropic-only setup where semantic recall can never arm because
// there is no embeddings endpoint to point it at. The ladder degrades to one tiny classify call that
// widens the query, and from there to today's plain keyword search.
//
// The expansion LANE is faked through the module's test seam (the flow gives no argument to inject
// through), so everything else — the backend gate, the post-processing, the concatenation, the
// tokenizer's cap — is the real thing.

let expansionCalls = 0;

/** Run `fn` with the expansion lane armed and faked. `text` is what the model "says"; a function
 *  throws instead, which is how every real failure (no lane, budget, provider) arrives. */
async function withExpansion(text: string | (() => never), fn: () => Promise<void>): Promise<void> {
  expansionCalls = 0;
  process.env.MEMORY_RECALL_EXPANSION = 'on';
  __setRecallExpansionLlmForTests((async () => {
    expansionCalls++;
    if (typeof text === 'function') text();
    return {
      text: text as string, toolCalls: [], stopReason: 'end_turn', truncated: false,
      provider: 'anthropic' as const, model: 'test',
    };
  }) as never);
  try {
    await fn();
  } finally {
    __setRecallExpansionLlmForTests(null);
    process.env.MEMORY_RECALL_EXPANSION = 'off';
  }
}

/** Drive one recall turn and return what the second pass was shown. */
async function recallPassText(a: ReturnType<typeof args>, query: string): Promise<string> {
  const seen: LlmRequest[] = [];
  await processConvoResult({
    ...a,
    res: makeResult(['one sec'], [recall(query)]),
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(['ruiz fencing did it'], []);
    }),
  });
  assert.equal(seen.length, 1, 'still exactly one second pass');
  return String(seen[0].messages[seen[0].messages.length - 1].content);
}

test('no embedder: the expanded query finds a row the words the user typed cannot reach', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);

  let text = '';
  // Not one word of the query is in the memory; 'fence'/'fencing' are.
  await withExpansion('fence fencing contractor', async () => {
    text = await recallPassText(a, 'who put up that boundary railing');
  });

  assert.equal(expansionCalls, 1, 'one call, on whichever lane this install already has');
  assert.match(text, /<memory_archive_results>/, 'the pass got DATA, not the honest-miss prompt');
  assert.match(text, /Ruiz Fencing/);
  // The MODEL is still shown the user's own question — the widening is a search detail, not
  // something to answer about.
  assert.match(text, /"who put up that boundary railing"/);

  // The control: unexpanded, that query reaches nothing at all.
  assert.deepEqual(
    await searchArchive({ query: 'who put up that boundary railing', handle: a.handle, chatId: a.chatId }),
    [],
  );
  await purgeArchiveFor({ handle: a.handle });
});

test('embedder registered: the expansion call is NEVER made', async () => {
  const a = args();
  await withExpansion('fence fencing contractor', async () => {
    await withSemanticRecall(async () => {
      await seedArchive(a.handle, a.chatId);
      await backfillArchiveEmbeddings({ batchSize: 20, maxBatches: 2 });
      const text = await recallPassText(a, 'who put up that boundary railing');
      assert.match(text, /Ruiz Fencing/, 'the vector leg answered it');
    });
  });
  // The whole point of the gate: the hybrid search already covers the paraphrase, so spending a
  // model call on synonyms would be paying twice for one thing — on the reply path, at that.
  assert.equal(expansionCalls, 0);
  await purgeArchiveFor({ handle: a.handle });
});

// M-9: 'vector' means an embedder is REGISTERED, not that there is anything for it to search. All
// through the backfill window — a fresh install, a model or width change — the flag is on and this
// scope holds no vectors at all, the hybrid search skips its own vector leg for exactly that reason,
// and gating expansion on the backend alone would leave recall with no paraphrase tolerance
// whatsoever: the one state where the fallback is most needed is the one it used to sit out.
test('semantic on but NO vectors yet: the expansion runs rather than sitting out the backfill window', async () => {
  const a = args();
  await withExpansion('fence fencing contractor', async () => {
    await withSemanticRecall(async () => {
      await seedArchive(a.handle, a.chatId);
      // Deliberately NO backfill: the archive row exists, its vector does not.
      const text = await recallPassText(a, 'who put up that boundary railing');
      assert.equal(expansionCalls, 1, 'the empty vector leg is not a reason to skip the fallback');
      assert.match(text, /Ruiz Fencing/, 'and the expanded lexical search found it');
    });
  });
  await purgeArchiveFor({ handle: a.handle });
});

test('an expansion that fails leaves the search byte-identical to an unexpanded one', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);

  let failed = '';
  await withExpansion(() => { throw new Error('provider down'); }, async () => {
    failed = await recallPassText(a, 'fence guy');
  });
  assert.equal(expansionCalls, 1, 'it did try');

  // The flag is back off after withExpansion, so this run makes no expansion call whatsoever —
  // exactly the pre-feature code path.
  const plain = await recallPassText(a, 'fence guy');
  assert.equal(failed, plain, 'a failed expansion is not a different search, it is the same search');
  await purgeArchiveFor({ handle: a.handle });
});

test('the user’s own terms keep priority: expansion only fills leftover token slots', async () => {
  const a = args();
  await seedArchive(a.handle, a.chatId);

  // searchArchive's tokenize() takes tokens IN ORDER and slices to MAX_QUERY_TOKENS (8), and the
  // recall site puts the query first — so an eight-token query leaves no room and the expansion is
  // inert, while the same question one word shorter lets exactly one synonym in.
  let atCap = '';
  let underCap = '';
  await withExpansion('fence fencing contractor', async () => {
    atCap = await recallPassText(a, 'who exactly put up that boundary railing yesterday'); // 8 tokens
    underCap = await recallPassText(a, 'who exactly put up that boundary railing');        // 7 tokens
  });

  assert.match(atCap, /Nothing in your archive matched/, 'a synonym never displaces a word the user typed');
  assert.ok(!atCap.includes('Ruiz Fencing'));
  assert.match(underCap, /Ruiz Fencing/, 'one free slot, one synonym, one hit');
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
