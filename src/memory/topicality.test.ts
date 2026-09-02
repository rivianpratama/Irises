// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The one lexical relevance verdict the memory stack and the thread engine share. Two things are
// under test and they are easy to confuse:
//
//   • the TOKENIZER — what counts as a topic word at all (length, case, punctuation, stopwords);
//   • `whenEmpty` — what a turn with NOTHING to compare means. It has two callers wanting opposite
//     answers, which is exactly why it is a parameter and not a constant: a memory block fails OPEN
//     (`'touch'`, never lose an entry over a bare "ok thanks") and a theme offer fails CLOSED
//     (`'no_touch'`, never name a pattern at someone on a turn that said nothing).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { touchesTurn, salientTokens, TOPIC_STOPWORDS } from './topicality.js';
import { topicallyRelated } from './wrappers.js';
import type { ShortTermEntry } from '../db/repositories/memoryShort.js';

// ── The tokenizer ────────────────────────────────────────────────────────────

test('salientTokens: lowercased, punctuation-split, stopwords and short words dropped', () => {
  assert.deepEqual([...salientTokens('Bitcoin PRICE, today?')], ['bitcoin', 'price', 'today']);
  // Under three characters carries no topic, whatever it is — and duplicates collapse.
  assert.deepEqual([...salientTokens('CI ci a an bitcoin bitcoin')], ['bitcoin']);
  assert.deepEqual([...salientTokens('')], []);
  // Digits survive: "q4" is two characters and gone, "2026" is a topic.
  assert.deepEqual([...salientTokens('the 2026 budget')], ['2026', 'budget']);
  // Every listed stopword really is dropped, so the list is not decorative.
  for (const w of TOPIC_STOPWORDS) assert.equal(salientTokens(w).size, 0, `${w} should not be salient`);
});

test('touchesTurn matches on ONE shared salient token, case and punctuation apart', () => {
  assert.equal(touchesTurn('any update on BITCOIN?', 'bitcoin price', { whenEmpty: 'no_touch' }), true);
  assert.equal(touchesTurn('what should i cook for dinner', 'bitcoin price', { whenEmpty: 'no_touch' }), false);
  // A shared STOPWORD is not a shared topic, in either mode.
  assert.equal(touchesTurn('what about that', 'what about this', { whenEmpty: 'no_touch' }), false);
  // Nor is a shared two-letter token.
  assert.equal(touchesTurn('is my ci green', 'ci pipeline', { whenEmpty: 'no_touch' }), false);
  // The candidate side is tokenized the same way — no match against an empty candidate.
  assert.equal(touchesTurn('bitcoin', '', { whenEmpty: 'touch' }), false);
  assert.equal(touchesTurn('bitcoin', 'the a an of', { whenEmpty: 'touch' }), false);
});

// ── whenEmpty, both directions ───────────────────────────────────────────────

test('whenEmpty decides a turn with no salient tokens, and nothing else does', () => {
  const emptyTurns: Array<string | undefined> = [
    undefined,          // no turn text at all (a legacy/non-convo caller)
    '',                 // a media-only turn
    '   ',              // whitespace
    'ok thanks',        // a pure ack: every token is a stopword
    'yeah, ok!',        // …punctuation and case do not rescue it
    'so at it up',      // stopwords and two-letter words only
  ];
  for (const turn of emptyTurns) {
    assert.equal(touchesTurn(turn, 'bitcoin price', { whenEmpty: 'touch' }), true,
      `${JSON.stringify(turn)} should fail OPEN in touch mode`);
    assert.equal(touchesTurn(turn, 'bitcoin price', { whenEmpty: 'no_touch' }), false,
      `${JSON.stringify(turn)} should fail CLOSED in no_touch mode`);
  }
  // `whenEmpty` is about the TURN, never the candidate: a token-bearing turn against a token-less
  // candidate is a real no-match, not an empty one.
  assert.equal(touchesTurn('bitcoin', '', { whenEmpty: 'touch' }), false);
});

// ── The wrapper that predates the module ─────────────────────────────────────

// `topicallyRelated` is the original of this logic and the short-tier hot-look gate rides on it, so
// its behavior must survive the extraction unchanged — including the fail-open default that lets a
// bare ack still close a loop from the hot look.
test('topicallyRelated is touchesTurn in touch mode over the entry ask', () => {
  const entry = { request: 'bitcoin price', meta: { topicKey: 'crypto' } } as unknown as ShortTermEntry;
  assert.equal(topicallyRelated(undefined, entry), true, 'no turn text → related');
  assert.equal(topicallyRelated('', entry), true, 'empty turn → related');
  assert.equal(topicallyRelated('ok thanks', entry), true, 'token-less ack → related');
  assert.equal(topicallyRelated('any update on bitcoin?', entry), true, 'shared request token');
  assert.equal(topicallyRelated('how is crypto doing', entry), true, 'shared topicKey token');
  assert.equal(topicallyRelated('what should i cook for dinner', entry), false, 'nothing shared');

  // An entry with nothing to compare against is still a real no-match on a topical turn.
  const bare = { request: null, meta: null } as unknown as ShortTermEntry;
  assert.equal(topicallyRelated('what should i cook for dinner', bare), false);
  assert.equal(topicallyRelated('ok thanks', bare), true, 'but the fail-open default still wins');
});
