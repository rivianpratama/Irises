// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The provenance grammar: three values, one rank order, one prefix, and the coercion that decides
// what a model's `basis` arg is worth. Every stored fact answers "who says so" — and the whole
// point of the rank order is that the answer can only ever get STRONGER (promote never demotes),
// so a guess she made can be replaced by their own words but never the other way round.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCES, PROV_RANK, PROV_PREFIX_RE, LEGACY_FACT_PROV, SEED_SOURCE,
  parseProvenance, normalizeFact, stampFact, promote, coerceBasis, provFromSource,
  provenanceEnabled,
} from './provenance.js';

test('PROVENANCES is the single source, and PROV_RANK ranks exactly it', () => {
  assert.deepEqual([...PROVENANCES], ['stated', 'inferred', 'seeded']);
  assert.deepEqual(Object.keys(PROV_RANK).sort(), [...PROVENANCES].sort());
  // stated 3 > seeded 2 > inferred 1: their own words beat an import, an import beats a guess.
  assert.ok(PROV_RANK.stated > PROV_RANK.seeded);
  assert.ok(PROV_RANK.seeded > PROV_RANK.inferred);
});

test('the prefix grammar is built FROM PROVENANCES — every value round-trips', () => {
  for (const prov of PROVENANCES) {
    assert.ok(PROV_PREFIX_RE.test(`${prov}: likes golf`), prov);
    const parsed = parseProvenance(stampFact(prov, 'likes golf'));
    assert.deepEqual(parsed, { prov, body: 'likes golf' }, prov);
  }
});

test('the grammar tolerates the spacing and casing a hand edit produces', () => {
  assert.deepEqual(parseProvenance('Stated:likes golf'), { prov: 'stated', body: 'likes golf' });
  assert.deepEqual(parseProvenance('INFERRED  :   likes golf'), { prov: 'inferred', body: 'likes golf' });
  // A multi-line body survives whole (a groomed note can carry newlines).
  assert.deepEqual(parseProvenance('seeded: line one\nline two'), { prov: 'seeded', body: 'line one\nline two' });
});

test('an unprefixed fact parses as itself with no provenance claimed', () => {
  assert.deepEqual(parseProvenance('drives a green truck'), { prov: null, body: 'drives a green truck' });
  // A word that is not one of the three is not a prefix, colon or no colon.
  assert.deepEqual(parseProvenance('guessed: drives a green truck'), { prov: null, body: 'guessed: drives a green truck' });
  // Nothing at all, and a prefix with no body, both degrade to the text itself.
  assert.deepEqual(parseProvenance(''), { prov: null, body: '' });
  assert.deepEqual(parseProvenance('stated:'), { prov: null, body: 'stated:' });
});

test('normalizeFact is the dedupe body: the prefix comes off, the wording does not', () => {
  assert.equal(normalizeFact('stated: Likes  Golf '), 'Likes  Golf ');
  assert.equal(normalizeFact('Likes  Golf '), 'Likes  Golf ');
  // Two rows that differ only in who says so are the SAME fact.
  assert.equal(normalizeFact('stated: likes golf'), normalizeFact('inferred: likes golf'));
});

test('stampFact never stacks a second prefix on an already-stamped row', () => {
  assert.equal(stampFact('stated', 'likes golf'), 'stated: likes golf');
  assert.equal(stampFact('stated', 'inferred: likes golf'), 'stated: likes golf');
  assert.equal(stampFact('inferred', 'stated: likes golf'), 'inferred: likes golf');
});

test('promote takes the max by rank and NEVER demotes', () => {
  assert.equal(promote('inferred', 'stated'), 'stated');
  assert.equal(promote('stated', 'inferred'), 'stated', 'a later guess cannot unseat their own words');
  assert.equal(promote('inferred', 'seeded'), 'seeded');
  assert.equal(promote('seeded', 'inferred'), 'seeded');
  assert.equal(promote('seeded', 'stated'), 'stated');
  assert.equal(promote('stated', 'seeded'), 'stated');
  for (const p of PROVENANCES) assert.equal(promote(p, p), p);
});

test('coerceBasis: only the word "stated" is a claim of testimony — everything else is a guess', () => {
  assert.equal(coerceBasis('stated'), 'stated');
  assert.equal(coerceBasis(' STATED '), 'stated');
  assert.equal(coerceBasis('inferred'), 'inferred');
  // Missing, garbage, wrong type, and a model claiming a seed it cannot have all land on inferred:
  // the conservative direction, because a wrong "stated" is a fact she will defend as testimony.
  assert.equal(coerceBasis(undefined), 'inferred');
  assert.equal(coerceBasis(null), 'inferred');
  assert.equal(coerceBasis(''), 'inferred');
  assert.equal(coerceBasis('probably'), 'inferred');
  assert.equal(coerceBasis(7), 'inferred');
  assert.equal(coerceBasis('seeded'), 'inferred');
});

test('a legacy row with no prefix defaults from its source: the engine seed is imported, the rest is testimony', () => {
  assert.equal(provFromSource(SEED_SOURCE), 'seeded');
  assert.equal(provFromSource('convo'), 'stated');
  assert.equal(provFromSource('groomer'), 'stated');
  assert.equal(provFromSource(undefined), 'stated');
  assert.equal(LEGACY_FACT_PROV, 'stated', 'the profile row has no source column — this is its default');
});

test('MEMORY_PROVENANCE_ENABLED is default OFF, read at call time, parsed like its siblings', () => {
  const prior = process.env.MEMORY_PROVENANCE_ENABLED;
  try {
    delete process.env.MEMORY_PROVENANCE_ENABLED;
    assert.equal(provenanceEnabled(), false, 'default OFF — this is the one flag on this branch that is');
    for (const on of ['true', '1', 'on', 'yes', 'YES', ' On ']) {
      process.env.MEMORY_PROVENANCE_ENABLED = on;
      assert.equal(provenanceEnabled(), true, on);
    }
    for (const off of ['false', '0', 'off', 'no', 'nonsense', '']) {
      process.env.MEMORY_PROVENANCE_ENABLED = off;
      assert.equal(provenanceEnabled(), false, off);
    }
  } finally {
    if (prior === undefined) delete process.env.MEMORY_PROVENANCE_ENABLED;
    else process.env.MEMORY_PROVENANCE_ENABLED = prior;
  }
});
