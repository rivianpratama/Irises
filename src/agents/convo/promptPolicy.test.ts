// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The prose has no other test. Every clause in RULE_ANCHORS was added to Context.md on purpose, and
// each one is a behaviour the live thread depends on — guess before you ask, the probe that wears a
// statement's clothes, the three-check gate, the play frame that keeps a tease off their wound. A
// rewrite that drops one of them looks like a tidy-up in review and shows up as drift in production
// weeks later. This file makes that deletion fail immediately, by id.
//
// Its other half is the same job pointed the other way: the two anchors at the recency edge RESTATE
// the bubble law, and the pipeline ENFORCES it (pipeline/bubbleJson.ts, pipeline/bubbles.ts). Those
// two statements of the same numbers must agree, or the model is told one law and held to another.
// promptSections.test.ts pins the prompt's exact bytes; this pins the RELATIONSHIP between the words
// and the constants, so changing a constant fails here instead of silently disagreeing.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections } from './shared.js';
import { RULE_ANCHORS } from './promptPolicy.js';
import { loadContext } from '../loadContext.js';
import { BUBBLE_LAW_MAX } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';

// ── the persona's load-bearing clauses ───────────────────────────────────────

test('every rule anchor is still in the persona, verbatim', () => {
  const persona = loadContext('convo');
  for (const { id, personaAnchor } of RULE_ANCHORS) {
    assert.ok(
      persona.includes(personaAnchor),
      `the "${id}" rule is gone from Context.md — its anchor no longer appears: ${JSON.stringify(personaAnchor)}. If the rewrite was deliberate, update RULE_ANCHORS in the same commit.`,
    );
  }
});

test('the anchor list is a usable index — unique ids, real phrases', () => {
  assert.ok(RULE_ANCHORS.length >= 8, 'the eight clauses this phase pinned are all listed');
  const ids = RULE_ANCHORS.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
  for (const { id, personaAnchor } of RULE_ANCHORS) {
    assert.ok(id.trim().length > 0, 'every anchor is named');
    // Long enough that the match means the CLAUSE is present, not a coincidence of common words.
    assert.ok(personaAnchor.trim().length >= 18, `${id}: the anchor is specific enough to be evidence`);
  }
});

// ── the bubble law, as stated vs as enforced ─────────────────────────────────

/** The two static bookends after `</prompt>`: the behaviour retelling, then the JSON contract. */
function anchors(): { behavior: string; json: string } {
  const { system } = buildSystemPromptSections(undefined, '');
  const behaviorAt = system.lastIndexOf('## Still the same Irises');
  const jsonAt = system.lastIndexOf('## Last thing before you type');
  assert.ok(behaviorAt > 0 && jsonAt > behaviorAt, 'both anchors are where the assembler puts them');
  return { behavior: system.slice(behaviorAt, jsonAt), json: system.slice(jsonAt) };
}

test('the JSON anchor states the bubble law in the numbers the pipeline enforces', () => {
  const { json } = anchors();
  assert.ok(
    json.includes(`target ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}, never exceeded, at most ${BUBBLE_LAW_MAX} items per reply`),
    'the law sentence reads off BUBBLE_WORD_TARGET_LO/HI, MAX_BUBBLE_WORDS and BUBBLE_LAW_MAX',
  );
  assert.ok(json.includes(String(BUBBLE_LAW_MAX)), 'the count the model is told is the exported one');
});

/** Small numbers as the anchors spell them. Only ever indexed by a bubble-law constant, so the list
 *  stops exactly where the law does. */
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five'] as const;

test("the behaviour anchor's retelling of the law agrees with the same constants", () => {
  // The retelling writes the count as a WORD ("three at most"), so it cannot be interpolated the way
  // the JSON anchor's sentence is — which is exactly why it needs a test: raising BUBBLE_LAW_MAX
  // would leave this line quietly telling her the old number.
  const { behavior } = anchors();
  assert.ok(BUBBLE_LAW_MAX < SPELLED.length, 'the law is still a number this list can spell');
  assert.ok(
    behavior.includes(`${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, ${SPELLED[BUBBLE_LAW_MAX]} at most`),
    `the behaviour anchor says "${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, ${SPELLED[BUBBLE_LAW_MAX]} at most" — it has drifted from the pipeline constants`,
  );
});
