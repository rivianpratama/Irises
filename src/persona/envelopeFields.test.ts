// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The hidden envelope's TABLE — who is in it, and who reads each row back. status.test.ts owns the
// coercion, the merge and the renders; this file owns ENVELOPE_FIELDS itself, because the v2 shrink
// turned the `consumers` column from documentation into a RULE.
//
// Before v2 the envelope had seventeen fields and four of them were read by nothing at all
// (`conviction`, `engagement`, `epistemic_trigger`, `profile_note`) — an empty `consumers` list was a
// documented fact. It is now a failure: every field costs the model a decision on every single turn
// and costs the prompt a bullet in the contract, so a field nobody reads back is weight in two places
// at once. Eight fields, eight rows, eight readers.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENVELOPE_FIELDS, STATUS_SCHEMA_PROP, type EnvelopeField } from './status.js';

/** The v2 envelope, spelled out — the closed set and the emission order, which is also the schema's
 *  `required` order and the contract's bullet order. Written here as a literal rather than derived
 *  from the table, because a table that lost or gained a field would derive its own new answer. */
const V2_KEYS: readonly string[] = [
  'mood_label', 'mood_shift', 'intent_mode', 'terminal_closure',
  'epistemic_trigger', 'meta_prompt', 'thread_note', 'thread_outcome',
];

/** The modules that declare every name the `consumers` column can use. Read as SOURCE rather than
 *  imported: pulling threadHarvest.ts into a persona unit test would drag the repositories (and
 *  node:sqlite) in behind it, and the question being asked is only "does this name still exist".
 *  `mood.ts` and `affectDrift.ts` joined the list in v2 — the two modules that took over the fields
 *  the model stopped reporting. */
const CONSUMER_SOURCES = ['./status.ts', './mood.ts', './affectDrift.ts', './threads.ts', '../memory/threadHarvest.ts'] as const;

/** The rule, as a function, so the negative case below can be a real assertion rather than a claim
 *  about what would happen. Returns the keys nothing is named for. */
function unreadFields(rows: readonly EnvelopeField[]): string[] {
  return rows.filter(f => f.consumers.length === 0).map(f => f.key);
}

test('the envelope is exactly the eight v2 fields, in emission order', () => {
  assert.deepEqual(
    ENVELOPE_FIELDS.map(f => f.key), V2_KEYS,
    'the shrink from seventeen fields to eight is a one-way migration — a field added back here is '
    + 'a field the model must fill on every turn, so it needs a reader and a row, not just a key',
  );
});

test('the schema both lanes validate against requires those eight keys and nothing else', () => {
  const p = STATUS_SCHEMA_PROP as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(p.required, V2_KEYS);
  assert.deepEqual(Object.keys(p.properties), V2_KEYS);
});

test('every field names code that reads it back — an unread field is a failure now, not a fact', () => {
  assert.deepEqual(
    unreadFields(ENVELOPE_FIELDS), [],
    'these fields are emitted and persisted but nothing branches on them: give each one a reader or '
    + 'delete the row (persona/status.ts). The four v1 fields with no reader are what the shrink deleted.',
  );

  // …and the check can really fail: the same predicate over a row with an empty column.
  const orphan: EnvelopeField = {
    key: 'meta_prompt', type: 'string', required: true, description: 'x', consumers: [],
  };
  assert.deepEqual(unreadFields([...ENVELOPE_FIELDS, orphan]), ['meta_prompt']);
});

test('every consumer the table names is still an exported function', () => {
  const src = CONSUMER_SOURCES
    .map(rel => readFileSync(new URL(rel, import.meta.url), 'utf8'))
    .join('\n');
  const listed = [...new Set(ENVELOPE_FIELDS.flatMap(f => f.consumers))].sort();
  assert.ok(listed.length >= 5, 'the column still names the readers it did — this check went vacuous');
  for (const name of listed) {
    assert.match(
      src, new RegExp(`export (?:async )?function ${name}\\(`),
      `\`${name}\` is listed as a consumer but no longer declared in ${CONSUMER_SOURCES.join(' / ')} — it `
      + 'was renamed, moved or deleted. Fix the column (persona/status.ts) in the same commit, or the one '
      + 'documented map of who reads the envelope is now fiction.',
    );
  }
  for (const f of ENVELOPE_FIELDS) {
    assert.equal(new Set(f.consumers).size, f.consumers.length, `${f.key}: no consumer listed twice`);
  }
});

// The three fields the drift engine reads are the whole of the model's influence over the gauges it
// owns (persona/affectDrift.ts): a DIRECTION for mood, a widening for how the mind was changed, and
// how the last thread offer actually landed. If one of these rows ever stops naming it, the model is
// reporting into a void — the gauge it was meant to move is now decided by the clock alone.
test('the fields the gauges are computed from name the engine that computes them', () => {
  const consumersOf = (key: string) => ENVELOPE_FIELDS.find(f => f.key === key)!.consumers;
  for (const key of ['mood_shift', 'epistemic_trigger', 'thread_outcome']) {
    assert.ok(
      consumersOf(key).includes('applyAffectDrift'),
      `\`${key}\` is an input to the drift engine and must say so: ${JSON.stringify(consumersOf(key))}`,
    );
  }
  // `mood_label` is the other half of the bargain: the WORD decides the core (and through it the
  // valence band the level may sit in), which is why the model no longer reports a core at all.
  assert.ok(consumersOf('mood_label').includes('coreForLabel'), 'the word is what files the core');
  assert.ok(consumersOf('mood_label').includes('renderStatusForPrompt'), 'and it rides next turn\'s weather');
});
