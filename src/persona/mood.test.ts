import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOOD_CORES, WILLCOX_WHEEL, EXTENDED_WORDS, wheelWords, feelingWords,
  isMoodCore, normalizeMoodLabel, coreForLabel, CORE_VALENCE_BAND, type MoodCore,
} from './mood.js';

// The exact Gloria Willcox wheel, transcribed from the chart — the completeness contract.
const WHEEL: Record<MoodCore, { secondary: string[]; tertiary: string[] }> = {
  mad: { secondary: ['hurt', 'hostile', 'angry', 'rage', 'hateful', 'critical'], tertiary: ['jealous', 'selfish', 'frustrated', 'furious', 'irritated', 'skeptical'] },
  scared: { secondary: ['rejected', 'confused', 'helpless', 'submissive', 'insecure', 'anxious'], tertiary: ['bewildered', 'discouraged', 'insignificant', 'weak', 'foolish', 'embarrassed'] },
  joyful: { secondary: ['excited', 'sexy', 'energetic', 'playful', 'creative', 'aware'], tertiary: ['daring', 'fascinating', 'stimulating', 'amused', 'extravagant', 'delightful'] },
  powerful: { secondary: ['proud', 'respected', 'appreciated', 'important', 'faithful', 'hopeful'], tertiary: ['cheerful', 'satisfied', 'valuable', 'worthwhile', 'intelligent', 'confident'] },
  peaceful: { secondary: ['content', 'thoughtful', 'intimate', 'loving', 'trusting', 'nurturing'], tertiary: ['thankful', 'sentimental', 'serene', 'responsive', 'relaxed', 'pensive'] },
  sad: { secondary: ['guilty', 'ashamed', 'depressed', 'lonely', 'bored', 'sleepy'], tertiary: ['apathetic', 'inferior', 'inadequate', 'miserable', 'stupid', 'bashful'] },
};

test('WILLCOX_WHEEL is the COMPLETE wheel — every core has its exact 6 secondary + 6 tertiary words', () => {
  for (const core of MOOD_CORES) {
    assert.deepEqual(WILLCOX_WHEEL[core].secondary, WHEEL[core].secondary, `${core} secondary`);
    assert.deepEqual(WILLCOX_WHEEL[core].tertiary, WHEEL[core].tertiary, `${core} tertiary`);
  }
});

test('the wheel has all 72 distinct words (nothing missed, no dupes within the wheel)', () => {
  const all = MOOD_CORES.flatMap(wheelWords);
  assert.equal(all.length, 72);
  assert.equal(new Set(all).size, 72);
});

test('the invented extra shades are KEPT alongside the wheel', () => {
  assert.ok(EXTENDED_WORDS.scared.includes('overwhelmed'));
  assert.ok(EXTENDED_WORDS.peaceful.includes('tender'));
  for (const w of ['drained', 'withdrawn', 'tired']) assert.ok(EXTENDED_WORDS.sad.includes(w), w);
  for (const w of ['cheerful', 'delighted', 'stimulated', 'curious', 'fascinated']) assert.ok(EXTENDED_WORDS.joyful.includes(w), w);
  // feelingWords is the union: wheel + extras
  assert.ok(feelingWords('sad').includes('miserable'));  // wheel
  assert.ok(feelingWords('sad').includes('drained'));    // extra
});

test('normalizeMoodLabel keeps any recognized word (wheel or extra), else falls back to the core', () => {
  assert.equal(normalizeMoodLabel('joyful', 'hopeful'), 'hopeful');   // cross-core wheel word kept
  assert.equal(normalizeMoodLabel('joyful', 'curious'), 'curious');   // extra shade kept
  assert.equal(normalizeMoodLabel('sad', 'MISERABLE'), 'miserable');  // case-normalized wheel word
  assert.equal(normalizeMoodLabel('peaceful', 'zzzqqq'), WILLCOX_WHEEL.peaceful.secondary[0]); // garbage → fallback
});

test('isMoodCore + valence bands cover the six cores', () => {
  for (const core of MOOD_CORES) {
    assert.ok(isMoodCore(core));
    const [lo, hi] = CORE_VALENCE_BAND[core];
    assert.ok(lo >= 1 && hi <= 100 && lo < hi);
  }
  assert.ok(!isMoodCore('grumpy'));
});

// `moodTexture` is deleted: the five bands of prose it returned described a level instead of
// changing a reply, and what a mood changes is now the core's own imperative (CORE_DIRECTIVES,
// persona/affectCompiler.ts). What this module still owes that table is the CHART — every word the
// model may report has to land on exactly one of the six cores, or the imperative is picked for a
// mood she is not in.
test('every word of the vocabulary files under exactly one core', () => {
  for (const core of MOOD_CORES) {
    for (const word of feelingWords(core)) {
      assert.ok(isMoodCore(coreForLabel(word)), `${word} places somewhere on the chart`);
    }
  }
  // The chart's own answers, at the two ends and at the fallback.
  assert.equal(coreForLabel('hopeful'), 'powerful');
  assert.equal(coreForLabel('MISERABLE'), 'sad');
  assert.equal(coreForLabel('zzzqqq'), 'peaceful');
});
