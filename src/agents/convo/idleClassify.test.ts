// Coverage for layer 3 of the idle gate as it is actually wired: the classify call, its deadline,
// its cache and its receipt (convo/idleClassify.ts), driven through the real `isIdleTurn` so the
// thing under test is the SEAM rather than a mock of it.
//
// The gate itself (persona/idle.ts) has its own suite for the vetoes and the fast path. What is
// pinned here is everything that file deliberately refuses to know: which lane, how long, how often,
// and what the ring gets to see afterwards.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_CLASSIFY_CACHE_MAX, IDLE_CLASSIFY_MAX_TOKENS, IDLE_CLASSIFY_PROMPT, IDLE_CLASSIFY_TIMEOUT_MS,
  clearIdleClassifyCache, idleCacheKey, idleClassifyCacheSize, makeIdleClassifier, readIdleVerdict,
} from './idleClassify.js';
import { isIdleTurn, type IdleFacts } from '../../persona/idle.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

/** Nothing structural in the way, so every message below reaches the layer under test. */
const CLEAR: IdleFacts = {
  attachmentNote: false, burstSize: 1, activeOps: false, pendingQuestion: false, consent: 'unclear',
};

/** A short stall in a script the English fast path cannot read a single token of — the exact case
 *  this layer exists for (persona/idle.ts's header names it). */
const NON_ENGLISH_STALL = 'ちょっとね';

function result(text: string): LlmResult {
  return { text, toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function setup() {
  clearTraces();
  clearIdleClassifyCache();
}

function receipts() {
  return getTraces().filter(e => e.type === 'event' && e.label === 'idle:classify').map(e => e.detail);
}

// ── the verdict reader ───────────────────────────────────────────────────────

test('a one-word answer is read past its punctuation, and anything unknown is unclear', () => {
  assert.equal(readIdleVerdict('stall'), 'stall');
  assert.equal(readIdleVerdict('  STALL.\n'), 'stall', 'a lane that punctuates has still answered');
  assert.equal(readIdleVerdict('ask'), 'ask');
  assert.equal(readIdleVerdict('unclear'), 'unclear');
  // Failing toward task: everything that is not one of the three is the third one.
  for (const junk of ['', null, undefined, 'idle', 'yes', '{"verdict":"stall"}']) {
    assert.equal(readIdleVerdict(junk as string), 'unclear', JSON.stringify(junk));
  }
});

test('the cache key ignores case and spacing and NOTHING else', () => {
  assert.equal(idleCacheKey('  Hmm   OK '), 'hmm ok');
  // Deliberately not the gate's tokenizer, which drops every non-Latin character: two different
  // stalls in the same script must not collapse onto one key.
  assert.notEqual(idleCacheKey('ちょっとね'), idleCacheKey('そうだね'));
});

// ── the three layers, driven end to end ──────────────────────────────────────

test('a stall verdict makes the turn idle, and the receipt says the classify layer decided', async () => {
  setup();
  let asked = 0;
  const classify = makeIdleClassifier({
    chatId: 'c1', handle: '+15550001111', llm: async () => { asked++; return result('stall'); },
  });
  assert.deepEqual(await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify), { idle: true, layer: 'classify' });
  assert.equal(asked, 1);
  assert.deepEqual(receipts(), [{ verdict: 'stall', cached: false, chars: 5 }]);
});

test('a thrown lane is a TASK turn, and the receipt says the call failed rather than answered', async () => {
  setup();
  const classify = makeIdleClassifier({
    chatId: 'c1', llm: async () => { throw new TypeError('no classify lane configured'); },
  });
  assert.deepEqual(await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify), { idle: false, layer: 'classify' });
  const [only] = receipts();
  assert.equal((only as { verdict: string }).verdict, 'unclear', 'a dead lane settles nothing');
  assert.equal((only as { failed?: string }).failed, 'TypeError', 'and the receipt tells a dead lane from a hedging one');
});

test('an `ask` verdict is a task turn — only the exact word stall is idle', async () => {
  setup();
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('ask') });
  assert.deepEqual(await isIdleTurn('kirim ke mereka sekarang', CLEAR, classify), { idle: false, layer: 'classify' });
});

test('a failure is NOT cached — the next turn gets its own attempt', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({
    chatId: 'c1',
    llm: async () => { calls++; if (calls === 1) throw new Error('lane down'); return result('stall'); },
  });
  assert.equal((await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify)).idle, false);
  assert.equal(idleClassifyCacheSize(), 0, 'nothing was learned, so nothing is remembered');
  assert.equal((await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify)).idle, true, 'the lane came back');
  assert.equal(calls, 2);
});

// ── the call itself ──────────────────────────────────────────────────────────

test('the call is the classify lane, five tokens, the fixed prompt, and the message as DATA', async () => {
  setup();
  const seen: LlmRequest[] = [];
  const classify = makeIdleClassifier({
    chatId: 'c9', handle: '+15550001111', llm: async req => { seen.push(req); return result('stall'); },
  });
  await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, 'classify');
  assert.equal(seen[0].maxTokens, IDLE_CLASSIFY_MAX_TOKENS);
  assert.equal(seen[0].system, IDLE_CLASSIFY_PROMPT);
  assert.equal(seen[0].trace?.label, 'idle:classify_call', 'the CALL and the decision are separate labels');
  const content = String(seen[0].messages[0].content);
  assert.match(content, /^<prompt>/, 'wrapped, so the message is context and not instruction');
  assert.match(content, /<message>[\s\S]*ちょっとね[\s\S]*<\/message>/, 'and sub-tagged as their own words');
  // The prompt is Fable's, and it defines all three words it will accept back.
  for (const word of ['stall', 'ask', 'unclear']) assert.ok(IDLE_CLASSIFY_PROMPT.includes(`${word} —`), word);
});

test('the deadline fires and the turn goes on as work', async () => {
  setup();
  // A lane that answers, eventually, and far too late — which is the failure a hard deadline exists
  // for and the one a thrown call cannot stand in for. The wait is shortened through the same kind
  // of seam `llm` is; the production number is pinned on its own two lines below.
  let late: ReturnType<typeof setTimeout> | undefined;
  const classify = makeIdleClassifier({
    chatId: 'c1',
    timeoutMs: 20,
    llm: () => new Promise<LlmResult>(resolve => { late = setTimeout(() => resolve(result('stall')), 5_000); }),
  });
  const reading = await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify);
  clearTimeout(late);
  assert.deepEqual(reading, { idle: false, layer: 'classify' }, 'a lane that missed the deadline settles nothing');
  assert.equal((receipts()[0] as { failed?: string }).failed, 'Error');
  assert.equal(idleClassifyCacheSize(), 0, 'and a timeout teaches the cache nothing');

  // This call sits ON the reply path, ahead of the prompt build: the number is a latency budget, not
  // a formality, and six seconds is generous for a five-token answer.
  assert.equal(IDLE_CLASSIFY_TIMEOUT_MS, 6_000);
});

// ── the cache ────────────────────────────────────────────────────────────────

test('the same stall costs ONE call however many turns it arrives on, and every hit is receipted', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => { calls++; return result('stall'); } });
  for (const text of [NON_ENGLISH_STALL, NON_ENGLISH_STALL, `  ${NON_ENGLISH_STALL.toUpperCase()} `]) {
    assert.equal((await isIdleTurn(text, CLEAR, classify)).idle, true, text);
  }
  assert.equal(calls, 1, 'a person\'s handful of stalls is a handful of calls, not one per turn');
  // A cache hit that filed nothing would make a busy install look like a lane nobody is calling.
  assert.deepEqual(receipts().map(d => (d as { cached: boolean }).cached), [false, true, true]);
});

test('the cache is capped, and it evicts the oldest reading first', async () => {
  setup();
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('stall') });
  // Distinct short messages made of LETTERS only: a digit anywhere is a structural veto, so a
  // numbered fixture would never reach the layer being filled up here (persona/idle.ts).
  const nth = (n: number) => `s${n.toString(2).replace(/0/g, 'a').replace(/1/g, 'b')}`;
  // One over the cap, so exactly one eviction has happened and it is the first key in.
  for (let i = 0; i <= IDLE_CLASSIFY_CACHE_MAX; i++) await isIdleTurn(nth(i), CLEAR, classify);
  assert.equal(idleClassifyCacheSize(), IDLE_CLASSIFY_CACHE_MAX);
  clearTraces();
  await isIdleTurn(nth(0), CLEAR, classify);
  assert.equal((receipts()[0] as { cached: boolean }).cached, false, 'the oldest reading is the one that went');
  clearTraces();
  await isIdleTurn(nth(IDLE_CLASSIFY_CACHE_MAX), CLEAR, classify);
  assert.equal((receipts()[0] as { cached: boolean }).cached, true, 'and the newest is still held');
});

test('a structural veto and the fast path both settle the turn without a call at all', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => { calls++; return result('stall'); } });
  // Layer 1: a digit is a fact, and a message carrying one is carrying something to act on.
  assert.deepEqual(await isIdleTurn('deploy 3 now', CLEAR, classify), { idle: false, layer: 'veto' });
  // Layer 2: every token is a known English stall.
  assert.deepEqual(await isIdleTurn('hey', CLEAR, classify), { idle: true, layer: 'fast_path' });
  assert.equal(calls, 0, 'the lane is only reached by what the two free layers could not read');
  assert.deepEqual(receipts(), [], 'and a layer that never ran files nothing');
});

test('the receipt carries a size and a verdict — never the message', async () => {
  setup();
  const secret = 'ちょっとね';
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('stall') });
  await isIdleTurn(secret, CLEAR, classify);
  assert.doesNotMatch(JSON.stringify(receipts()), new RegExp(secret));
});
