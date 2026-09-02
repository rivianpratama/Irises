// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The prose has no other test. Every clause in RULE_ANCHORS was added to Context.md on purpose, and
// each one is a behaviour the live thread depends on — guess before you ask, the probe that wears a
// statement's clothes, the three-check gate, the play frame that keeps a tease off their wound. A
// rewrite that drops one of them looks like a tidy-up in review and shows up as drift in production
// weeks later. This file makes that deletion fail immediately, by id.
//
// Its other half is the same job pointed the other way: the JSON anchor at the recency edge STATES
// the bubble law, and the pipeline ENFORCES it (pipeline/bubbleJson.ts, pipeline/bubbles.ts). The
// statement and the backstop must agree, or the model is told one law and held to another.
// promptSections.test.ts pins the prompt's exact bytes; this pins the RELATIONSHIP between the words
// and the constants, so changing a constant fails here instead of silently disagreeing. Since P1 the
// JSON anchor is the ONLY place in Convo's prompt that states the numbers, and the check below holds
// it that way.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections } from './shared.js';
import { RULE_ANCHORS } from './promptPolicy.js';
import { loadContext } from '../loadContext.js';
import { BUBBLE_LAW_MAX } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';
import type { ThreadRung } from '../../persona/threads.js';

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

// ── the threading ladder, as taught vs as deliverable ────────────────────────
//
// The selector can only ever hand her a `fact`, a `pattern` or a `shorthand` offer (ThreadRung,
// persona/threads.ts) — three rungs. The persona taught FIVE, splitting fact into question and
// connection and pattern into soft and named, so two of the rungs it asked her to climb do not
// exist downstream and no code could ever confirm one had been earned. Now it teaches three, and
// this holds the two ladders in step.

/** The rungs lowest-first. A Record keyed by ThreadRung, so renaming or adding a rung in
 *  persona/threads.ts breaks THIS LINE — which is the point: the type is the source, and the
 *  persona's prose has to follow it. */
const RUNG_ORDER: Record<ThreadRung, number> = { fact: 0, pattern: 1, shorthand: 2 };
const RUNGS = (Object.keys(RUNG_ORDER) as ThreadRung[]).sort((a, b) => RUNG_ORDER[a] - RUNG_ORDER[b]);

test('the persona teaches exactly the rungs the engine can deliver, in the same order', () => {
  const persona = loadContext('convo');
  const at = persona.indexOf('**The ladder — enter one rung lower than you could.**');
  assert.ok(at > 0, 'found the ladder paragraph in "Connect the dots"');
  const ladder = persona.slice(at, persona.indexOf('\n', at));

  assert.ok(ladder.includes('Three rungs'), `the ladder still claims a different height: ${ladder.slice(0, 120)}`);
  const positions = RUNGS.map(rung => ({ rung, at: ladder.indexOf(rung) }));
  for (const { rung, at: found } of positions) {
    assert.ok(found >= 0, `the ${rung} rung is missing from the ladder — the engine can still offer one`);
  }
  assert.deepEqual(
    [...positions].sort((a, b) => a.at - b.at).map(p => p.rung), RUNGS,
    'the ladder climbs in the order the rung ceiling drops through: fact → pattern → shorthand',
  );

  // The five-rung version is gone, not just outnumbered: its two extra rungs were "a fact
  // connection" and "a named theme", neither of which the selector can express.
  assert.ok(!/[Ff]ive rungs/.test(persona), 'the five-rung ladder is still in the persona');
  assert.ok(!persona.includes('a named theme ("the perfectionism loop again?")'), 'the named-theme rung is still listed');
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

test('the behaviour anchor states no bubble number at all — the JSON anchor owns the law', () => {
  // Until P1 the behaviour anchor retold the law in its own words ("5-12 words, three at most"), so
  // raising a constant left it quietly telling her the old number. The fix was not a better
  // interpolation but a deletion: the law is stated ONCE, in the JSON anchor above. This holds that —
  // any digit reappearing here is a second statement of a number, which is how the two drift apart.
  const { behavior } = anchors();
  const digits = behavior.match(/\d+/g) ?? [];
  assert.deepEqual(digits, [], 'a number came back into the behaviour anchor — state it in the JSON anchor instead');
  const bullets = behavior.split('\n').filter(l => l.startsWith('- '));
  assert.equal(bullets.length, 6, 'the anchor is the six lines that drift first, and stays that short');
});
