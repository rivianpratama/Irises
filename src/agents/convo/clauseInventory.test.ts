// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// How many times the model is told the same thing.
//
// Four of Convo's load-bearing clauses used to reach it TWICE on every turn — once in the persona's
// own section, once in the behaviour anchor at the recency edge. The second copy was deliberate (a
// 146k prompt loses its middle, so the anchor re-stated what decays), but a retelling can drift from
// its source, and a rule stated twice is a rule nobody can edit. Nothing had ever counted them.
//
// This file counts them against the assembled prompt and pins the numbers, which live in ONE
// exported table (CLAUSE_INVENTORY, promptPolicy.ts) so that collapsing a duplicate is a one-line
// diff there rather than a hunt through a test. P1 did exactly that: the behaviour anchor's copies
// are gone and every row is pinned at ONE. It also holds the one structural rule that falls out of
// the same reading: no `## ` heading appears twice in the prompt — a duplicated heading is how two
// blocks end up claiming to be the same section.
//
// It changes nothing and shrinks nothing itself. A count that MOVES is the failure, in either
// direction: up means a copy came back, down means a rule was deleted without anyone deciding to.
//
// It counts over the WHOLE corpus, which since P4a takes one line of setup. Eight sections of the
// persona are now craft pages that load only on the turns that need them (convo/personaModules.ts),
// so a prompt assembled on any one turn carries some of them and not others — and a clause counted
// against that prompt would read 1 on a turn where its page loaded and 0 on a turn where it didn't.
// The flag's OFF path is exactly the concatenation of all of them, so the census builds its turn with
// CONVO_PERSONA_MODULES off: every page present, once, which is both the honest answer to "how many
// times is she told this" and the same string these counts were originally measured against.
//
// For the same reason the turn below is a HOOK turn carrying a real THESIS, rather than the plain
// task turn most live turns are. Both choices buy the same thing: the sections that only exist on
// some turns are exactly where a clause can quietly acquire a second copy and where two blocks can
// end up claiming one heading, so a census that never rendered them would be a census of a corpus
// nobody is ever handed. The thesis is the newest heading in the whole prompt, and it was the one
// heading the uniqueness check could not see.
process.env.TZ = 'UTC';
// Set before the prompt is assembled at module scope below — see the header.
process.env.CONVO_PERSONA_MODULES = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections } from './shared.js';
import { CLAUSE_INVENTORY } from './promptPolicy.js';
import { renderUserMemory } from '../../memory/wrappers.js';
import { coerceStatus, mergeStatus, ENVELOPE_FIELDS, type AffectState, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { defaultClimate, type RelationshipClimate } from '../../persona/climate.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { HookDirective } from '../../persona/hooks.js';
import { renderThesisSection } from '../../memory/thesisEngine.js';
import type { LlmToolDef } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// A pinned clock, the promptSections.test.ts way (no MockTimers, so no ExperimentalWarning): nothing
// here is measured in characters, but the timing prose reads the wall clock and a frozen instant
// keeps the assembled string — and therefore the heading census below — the same on every run.
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// ── one loaded turn ──────────────────────────────────────────────────────────
// Loaded on purpose: the more prose blocks render, the more chances a clause has to appear a third
// time and a heading has to collide. So this turn carries the tool docs, a full memory stack, her
// weather, a thread offer, the timing reads and the turn-focus block.

const HANDLE = '+15550001111';
const TURN_TEXT = 'honestly i just want the cedars done right this time';

const PROFILE: UserProfile = {
  handle: HANDLE, name: 'Sam', facts: ['runs a plant nursery', 'hard rule: no calls before 10am'],
  firstSeen: Math.floor(FROZEN_MS / 1000) - 200 * 86_400, lastSeen: Math.floor(FROZEN_MS / 1000) - 1200,
};

const TOOL: LlmToolDef = {
  name: 'delegate_to_ops',
  description: 'Hand a real look-up to your deep worker.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['web_research', 'compute'], description: 'which lane the ask belongs to' },
      request: { type: 'string', description: 'the ask in their words' },
    },
    required: ['kind', 'request'],
  },
};

const MEMORY_STACK = renderUserMemory('convo', {
  profile: PROFILE,
  memory: null,
  medium: {
    directives: [{ id: 'd1', text: 'keep replies short unless i ask for the detail', createdAt: FROZEN_MS - 86_400_000 }],
    notes: ['the cedar order from the north supplier is late'],
    facts: { address_as: 'Sam', work: 'owns a plant nursery' },
  },
  short: [{
    id: 's1', agentHandle: HANDLE, kind: 'ops_research', request: 'cedar lead times',
    content: 'The north supplier lists 6-8 weeks on cedar right now, up from 4 in the spring.',
    meta: {}, createdAt: FROZEN_MS - 10 * 60_000, expiresAt: FROZEN_MS + 20 * 3600_000,
  }],
  longDocMd: '## Who they are\nSam. Runs a wholesale-and-retail plant nursery outside Bend.\n\n## How to text them\nCasual, lowercase, short.',
}, FROZEN_MS, { audience: 'individual', currentTurnText: TURN_TEXT });

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};

const AFFECT: AffectState = (() => {
  const emitted = coerceStatus({
    mood_label: 'hopeful', mood_shift: 'lifted', intent_mode: 'sharing_update',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
  })!;
  // The gauges are code's answer now (persona/affectDrift.ts), so the row she carried IN is STATED
  // rather than emitted into place — a clause count is about prose, not about the arithmetic.
  const last = {
    ...mergeStatus(emitted, COMPUTED, 0),
    mood_level: 72, anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, patience: 75,
  };
  return { last, moodHistory: [] };
})();

const MOVED_CLIMATE: RelationshipClimate = {
  ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30,
};

const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft', note: 'they keep landing back on shipping fast versus doing it right',
};

const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: HANDLE, at: FROZEN_MS - 40 * 60_000 },
  { role: 'assistant', content: 'six to eight weeks from the north supplier', at: FROZEN_MS - 38 * 60_000 },
];

/** The rhythm decision this census is taken under: an idle turn with every kind still open, which
 *  is the widest the `hooks` section gets (persona/hooks.ts). */
const HOOK_DIRECTIVE: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], sleepQuiet: false, moments: false, offerAllowed: true,
};

/** Her one read on this person, rendered through the real seam (memory/thesisEngine.ts), so the
 *  census sees THESIS_SECTION_HEADING the way a live turn prints it — heading and read, off the same
 *  clamp and the same split.
 *
 *  A real one for the same reason the turn is a hook turn: the heading census counts `## ` lines
 *  across the assembled prompt and pins that none appears twice, and a section that never renders is
 *  a heading the check never sees. `''` here left the newest heading in the corpus — the one added
 *  last, on the branch that added it — outside the one test written to catch a collision, which is
 *  precisely backwards. Two sentences, behaviour only, at about the length the writer prompt asks
 *  for; the words themselves do not matter to any count, but the heading does. */
const THESIS = renderThesisSection(
  'They decide fast on things that cost money and slowly on things that cost a conversation, which is '
  + 'why the supplier disputes sit open for weeks. They would rather re-do a job than ask someone to '
  + 'fix it, and they read a question about the schedule as a question about their competence.',
);

const { system: PROMPT } = buildSystemPromptSections(
  { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: PROFILE },
  MEMORY_STACK, [], undefined, [TOOL], HISTORY, TURN_TEXT, 'UTC',
  AFFECT, COMPUTED, { classes: ['web', 'code'], complete: true }, MOVED_CLIMATE,
  { offer: THEME, outcomeAsk: null }, undefined,
  { text: TURN_TEXT, hits: [{ label: 'speed vs craft', source: 'thread' }] },
  { attachmentNote: false, emailFlag: false, thinProfile: false, idleTurn: true },
  // A HOOK turn, deliberately, even though nearly every live turn is a task one. The census counts
  // substrings across the whole assembled prompt, and the two things only an idle turn puts in it —
  // the `hooks` section and the craft page that teaches the beat — are exactly where a clause could
  // quietly acquire a second copy. A census taken on a task turn would count a corpus the live idle
  // turn does not have. (The drift anchor's mode moves with it, which is the point: `anchorCopies`
  // in promptPolicy.ts exists to account for a law restated at the recency edge.)
  { hooks: HOOK_DIRECTIVE, moments: [], thesis: THESIS },
);

/** Plain substring occurrences — the same number a reader gets from a plain text search. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── the counts ───────────────────────────────────────────────────────────────

test('every counted clause reaches the model exactly as often as it does today', () => {
  for (const { id, phrase, count, where } of CLAUSE_INVENTORY) {
    const found = occurrences(PROMPT, phrase);
    assert.equal(
      found, count,
      `${id}: the prompt carries ${JSON.stringify(phrase)} ${found}× (pinned at ${count}× — ${where}). More copies dilute the rule; fewer means one was deleted. Either way, update CLAUSE_INVENTORY in the same commit.`,
    );
  }
});

test('the inventory is a usable table — unique ids, every clause actually present', () => {
  assert.ok(CLAUSE_INVENTORY.length >= 10, 'the clauses this phase pinned are all listed');
  const ids = CLAUSE_INVENTORY.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
  const phrases = CLAUSE_INVENTORY.map(c => c.phrase);
  assert.equal(new Set(phrases).size, phrases.length, 'no phrase is counted twice under two names');
  for (const c of CLAUSE_INVENTORY) {
    assert.ok(c.count >= 1, `${c.id}: a pinned count of 0 is a deleted clause, not an inventory line`);
    assert.ok(c.where.trim().length > 0, `${c.id}: says where its copies live`);
  }
});

test('each count splits between the persona and the anchors exactly as the table says', () => {
  // This is what turns the table's prose into a fact: a clause stated once and retold at the recency
  // edge reads 2/1, and a clause duplicated INSIDE Context.md reads 2/0. P1 needed the difference —
  // the first was a deliberate anchor, the second was the thing to collapse.
  const anchorAt = PROMPT.lastIndexOf('## Still the same Irises');
  assert.ok(anchorAt > 0, 'found the behaviour anchor, where the two static bookends begin');
  const body = PROMPT.slice(0, anchorAt);
  const bookends = PROMPT.slice(anchorAt);
  for (const { id, phrase, count, anchorCopies, where } of CLAUSE_INVENTORY) {
    assert.equal(
      occurrences(bookends, phrase), anchorCopies,
      `${id}: the two anchors carry it a different number of times than the table's anchorCopies (${where})`,
    );
    assert.equal(
      occurrences(body, phrase), count - anchorCopies,
      `${id}: the persona and the per-turn block carry it a different number of times than count - anchorCopies (${where})`,
    );
  }
});

// A clause that lives on an ENVELOPE_FIELDS description reaches the model TWICE per turn from one
// source: once in the status contract, which this file counts, and once on the response schema, which
// it cannot see (the schema is the request's response_format, not part of the system prompt). The
// header above asks "how many times the model is told the same thing", so a row reading 1 with no
// mention of the second channel answers that question wrongly. `where` is the only place that can say
// it, which is what this holds.
test('a counted clause that rides a field description says so, and names its second channel', () => {
  const descriptions = ENVELOPE_FIELDS.map(f => f.description).join('\n');
  const fromSchema = CLAUSE_INVENTORY.filter(c => descriptions.includes(c.phrase));
  assert.ok(fromSchema.length > 0, 'no counted clause comes from ENVELOPE_FIELDS — this check went vacuous');
  for (const c of fromSchema) {
    assert.match(
      c.where, /response schema/,
      `${c.id}: its phrase is an ENVELOPE_FIELDS description, so the model also gets it on the response schema every turn. Say that in \`where\` — a reader of this file otherwise takes the pinned count as the whole answer.`,
    );
  }
});

// ── the structural half ──────────────────────────────────────────────────────

test('no section heading appears twice in the assembled prompt', () => {
  const headings = PROMPT.split('\n').filter(l => l.startsWith('## '));
  const seen = new Map<string, number>();
  for (const h of headings) seen.set(h, (seen.get(h) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([h, n]) => `${n}× ${JSON.stringify(h)}`);
  assert.deepEqual(dupes, [], 'two blocks are claiming the same heading');
  assert.ok(headings.length > 40, 'the census really read the loaded prompt');
});
