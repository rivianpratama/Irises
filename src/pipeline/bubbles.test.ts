import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitIntoBubbles, splitIntoBubblesWithSplits, splitLongBubble,
  MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI,
} from './bubbles.js';

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ── the regression this file exists for: walls of text in one bubble ────────────────────────────

test('an unpunctuated run-on over the ceiling is split into texting-sized bubbles', () => {
  // Lowercase texting voice, no periods, no --- : previously sailed through as ONE 29-word wall.
  const wall = 'the option period ends march 14 so you still have your contingency rights until then and i can pull the exact contract language for you if that would help you decide';
  const out = splitIntoBubbles(wall);
  assert.ok(out.length >= 2, `expected a split, got ${out.length} bubble(s)`);
  for (const b of out) assert.ok(words(b) <= MAX_BUBBLE_WORDS, `bubble over ceiling: "${b}"`);
  // Nothing lost: every word survives, only breaks were added.
  assert.equal(out.join(' ').replace(/,/g, ''), wall.replace(/,/g, ''));
});

test('splits at a natural clause seam (before a conjunction / after a comma), not mid-thought', () => {
  const b = 'rough cap rate looks like about six point two percent, that assumes ten percent vacancy and eight percent management on the year';
  const out = splitLongBubble(b);
  assert.ok(out.length >= 2);
  // The comma seam is the natural break: the left half ends where the pause was (comma dropped).
  assert.equal(out[0], 'rough cap rate looks like about six point two percent');
});

test('every fragment is re-checked: a 45-word wall becomes 3+ bubbles all under the ceiling', () => {
  const wall = Array.from({ length: 45 }, (_, i) => (i % 9 === 0 && i > 0 ? 'and' : `word${i}`)).join(' ');
  const out = splitLongBubble(wall);
  assert.ok(out.length >= 3);
  for (const b of out) assert.ok(words(b) <= MAX_BUBBLE_WORDS, `bubble over ceiling: "${b}"`);
});

test('falls back to a balanced mid-point split when there is no natural seam', () => {
  const noSeam = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
  const out = splitLongBubble(noSeam);
  assert.equal(out.length, 2);
  for (const b of out) assert.ok(words(b) <= MAX_BUBBLE_WORDS);
  assert.equal(out.join(' '), noSeam); // nothing lost
});

// ── what must NOT be touched ─────────────────────────────────────────────────────────────────

test('a bubble at or under the ceiling passes through untouched (persona keeps ownership)', () => {
  const fine = 'option period ends march 14';
  assert.deepEqual(splitLongBubble(fine), [fine]);
  const atCeiling = Array.from({ length: MAX_BUBBLE_WORDS }, (_, i) => `w${i}`).join(' ');
  assert.deepEqual(splitLongBubble(atCeiling), [atCeiling]);
});

test('a link bubble is never broken, whatever its length', () => {
  const link = 'tap here to open the full report i put together on that contract thread for you right away https://example.com/reports/2026/contract-thread?token=abc123&scope=read.only';
  assert.deepEqual(splitLongBubble(link), [link]);
});

test('tight ranges and currency survive whole across the full pipeline', () => {
  const t = 'comps on that block are running $1,800 – $2,000 a month for a three two with a garage so you have real room on rent there honestly';
  const out = splitIntoBubbles(t);
  assert.ok(out.some(b => b.includes('$1,800-$2,000')), `range chopped: ${JSON.stringify(out)}`);
  for (const b of out) assert.ok(words(b) <= MAX_BUBBLE_WORDS, `bubble over ceiling: "${b}"`);
});

// ── existing behavior still holds ────────────────────────────────────────────────────────────

test('normal ----split replies are untouched end to end', () => {
  const t = "option period ends march 14\n---\nyou've still got your contingency rights til then\n---\nwant me to pull the exact contract language?";
  assert.deepEqual(splitIntoBubbles(t), [
    'option period ends march 14',
    "you've still got your contingency rights til then",
    'want me to pull the exact contract language?',
  ]);
});

test('sentence boundaries still split even without ---', () => {
  const t = 'you are clear to close. the timeline works. want the contract language?';
  assert.deepEqual(splitIntoBubbles(t), [
    'you are clear to close.',
    'the timeline works.',
    'want the contract language?',
  ]);
});

test('abbreviations and decimals still do not trigger a sentence split', () => {
  assert.deepEqual(splitIntoBubbles('showing is at 9 a.m. tomorrow at the house'), ['showing is at 9 a.m. tomorrow at the house']);
  assert.deepEqual(splitIntoBubbles('rate came in at 6.5 today'), ['rate came in at 6.5 today']);
});

// ── the bubble-length law, single-sourced ────────────────────────────────────────────────────
// Every prompt that states the law (Convo's JSON anchor, both envelope schemas) now interpolates
// these three numbers instead of spelling them out, so the prose and the backstop can never drift.

test('the word-target band lives beside the ceiling it sits under', () => {
  assert.equal(BUBBLE_WORD_TARGET_LO, 5);
  assert.equal(BUBBLE_WORD_TARGET_HI, 12);
  assert.equal(MAX_BUBBLE_WORDS, 20);
  assert.ok(BUBBLE_WORD_TARGET_LO < BUBBLE_WORD_TARGET_HI, 'the band has to read low-to-high');
  assert.ok(BUBBLE_WORD_TARGET_HI < MAX_BUBBLE_WORDS, 'the target has to sit under the hard ceiling');
});

// ── the split count, for the send boundary's receipt ─────────────────────────────────────────

test('splitIntoBubblesWithSplits counts every ceiling split and loses no word', () => {
  // One unpunctuated 29-word run-on: the ONLY thing that can break it up is the word ceiling,
  // so the extra bubbles and the reported split count have to be the same number.
  const wall = 'the option period ends march 14 so you still have your contingency rights until then and i can pull the exact contract language for you if that would help you decide';
  const { bubbles, splits } = splitIntoBubblesWithSplits(wall);
  assert.ok(splits >= 1, 'a wall over the ceiling has to report a split');
  assert.equal(bubbles.length - 1, splits, 'one split per extra bubble the ceiling created');
  for (const b of bubbles) assert.ok(words(b) <= MAX_BUBBLE_WORDS, `bubble over ceiling: "${b}"`);
  assert.equal(bubbles.join(' ').replace(/,/g, ''), wall.replace(/,/g, ''), 'nothing lost');
});

test('splitIntoBubbles is the same output as the counted split, and a clean reply reports 0', () => {
  const t = "option period ends march 14\n---\nyou've still got your contingency rights til then";
  const counted = splitIntoBubblesWithSplits(t);
  assert.deepEqual(counted.bubbles, splitIntoBubbles(t), 'the plain splitter stays byte-identical');
  assert.equal(counted.splits, 0, 'no bubble was over the ceiling, so the ceiling never fired');
});
