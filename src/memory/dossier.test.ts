// Run with: npm test   (TZ=UTC tsx --test)
// Regression pins for the dossier updater's harvest contract: the two-family capture
// (operational + personal color), the canonical section order (= render-time eviction
// order), and the never-record-assistant-scope law. If a prompt edit drops one of these,
// the long doc quietly stops feeding connect-the-dots material to the front line.
// Plus attribution scoping (the cross-user nickname/style leak fix): the transcript it sees is
// already scoped to ONE user, its lines are labeled with the handle that said them, and the
// prompt tells the model to harvest only from those labeled user lines.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOSSIER_SYSTEM_PROMPT, buildDossierTranscript, dossierUpdateUsable, persistDossierMerge,
  formatDaySpan, buildContextBlock, buildContextBlockWithHot,
  dossierFactGuardEnabled, enforceKeyedFacts, enforceKeyedFactsWithChanges, keyedFactsForDossier,
  reinjectSeedProvenance, renderConfirmedFacts,
} from './dossier.js';
import { addShortTerm } from '../db/repositories/memoryShort.js';
import { saveDossier, clearDossier, getMemory, getForgetEpoch } from '../db/repositories/memory.js';
import { getLongDoc, listLongRevisions, saveLongDoc } from '../db/repositories/memoryLong.js';
import { PROVENANCE_LINE } from './seedFromEngine.js';
import { SEED_FACT_KEY, type Provenance } from './provenance.js';
import type { MediumBundle } from './mediumTerm.js';
import { clearTraces, getTraces } from '../diagnostics/trace.js';

// The coarse ladder shared by "last seen ~3 weeks ago" here and the climate eval's tenure label
// (climateDrift.ts). It was copied once and both copies carried the same year-boundary hole.
test('formatDaySpan: the day/week/month/year ladder, with no gap at the year boundary', () => {
  assert.equal(formatDaySpan(0), '0 days');
  assert.equal(formatDaySpan(1), '1 day');
  assert.equal(formatDaySpan(6), '6 days');
  assert.equal(formatDaySpan(7), '~1 week');
  assert.equal(formatDaySpan(20), '~2 weeks');
  assert.equal(formatDaySpan(34), '~4 weeks');
  assert.equal(formatDaySpan(35), '~1 month');
  assert.equal(formatDaySpan(359), '~11 months');
  // REGRESSION: 360-364 days fell between the month branch (mo < 12) and floor(days/365) === 0,
  // and rendered as "~0 years" — a full year of knowing someone, reported as none.
  assert.equal(formatDaySpan(360), '~1 year');
  assert.equal(formatDaySpan(364), '~1 year');
  assert.equal(formatDaySpan(365), '~1 year');
  assert.equal(formatDaySpan(800), '~2 years');
  // Nothing in the ladder can ever say zero of a unit.
  for (let d = 0; d <= 1500; d++) {
    assert.doesNotMatch(formatDaySpan(d), /~0 /, `${d} days rendered as none of a unit`);
  }
});

test('dossier prompt harvests both fact families', () => {
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('OPERATIONAL:'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('PERSONAL COLOR'));
  // The personal-color categories the weave depends on.
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('NAMES they use'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('arcs and goals'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('standing personal rules'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('recurring jokes'));
});

test('dossier prompt mandates the canonical section order (eviction order)', () => {
  const order = ['## Who they are', '## How they work', '## How to text them', '## Their world', '## Running jokes'];
  let last = -1;
  for (const heading of order) {
    const at = DOSSIER_SYSTEM_PROMPT.indexOf(`"${heading}"`);
    assert.ok(at !== -1, heading);
    assert.ok(at > last, `${heading} out of order`);
    last = at;
  }
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('later sections are dropped first'));
});

test('dossier prompt keeps the scope ban and the sensitive-ground rule', () => {
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes("NEVER record anything about the ASSISTANT's scope"));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('never infer or record the reason behind a habit or rule'));
  // A project of THEIRS is profile material, not throwaway task detail.
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('is NOT transient detail'));
});

// ── Attribution scoping (the cross-user nickname/style leak fix) ─────────────

test('DOSSIER_SYSTEM_PROMPT pins the attribution contract', () => {
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('ATTRIBUTION:'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('never something harvested from an assistant line alone'));
});

test('DOSSIER_SYSTEM_PROMPT keeps the scope/capability ban', () => {
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('NEVER record anything about the ASSISTANT'));
  assert.ok(DOSSIER_SYSTEM_PROMPT.includes('Out of scope'));
});

test('buildDossierTranscript labels the user lines with their handle', () => {
  const out = buildDossierTranscript('+15550001111', [
    { role: 'user', content: 'call me Ace', handle: '+15550001111' },
    { role: 'assistant', content: 'you got it, Ace' },
  ]);
  assert.equal(out, 'user (+15550001111): call me Ace\nassistant: you got it, Ace');
});

test('buildDossierTranscript falls back to the target handle for legacy null-handle rows', () => {
  const out = buildDossierTranscript('+15550001111', [{ role: 'user', content: 'old row' }]);
  assert.equal(out, 'user (+15550001111): old row');
});

// ── Persist guard (the truncated-rewrite corruption fix) ─────────────────────
// The updater returns the WHOLE merged document, so a cut-off reply doesn't lose the newest fact —
// it loses the tail sections the eviction order puts last (## Their world, ## Running jokes). Saving
// it deletes durable memory, and the next pass merges into the mutilated copy. Stale beats corrupted.

test('dossierUpdateUsable rejects a truncated rewrite, however plausible the text looks', () => {
  assert.equal(dossierUpdateUsable({ truncated: true }), false);
});

test('dossierUpdateUsable accepts a clean rewrite', () => {
  assert.equal(dossierUpdateUsable({ truncated: false }), true);
});

// ── The mid-merge /forget race + the clobbering conflict retry ────────────────
// The merge is read → LLM → write, so a /forget can land INSIDE it. persistDossierMerge is the
// post-LLM half, split out so both guards are testable with no model in the loop.

let seq = 0;
function freshHandle(): string {
  return `+1555400${(seq++).toString().padStart(4, '0')}`;
}

test('saveDossier refuses a write whose forget epoch is stale', async () => {
  const h = freshHandle();
  assert.equal(await saveDossier(h, 'first draft'), true, 'no epoch given → always writes');
  assert.equal(await saveDossier(h, 'clobber', { ifForgetEpoch: 99 }), false);
  assert.equal((await getMemory(h))?.dossierMd, 'first draft');
});

test('a /forget between the baseline read and the persist writes NOTHING', async () => {
  const h = freshHandle();
  await saveDossier(h, 'they run a print shop');
  const epoch0 = getForgetEpoch(h);

  await clearDossier(h);   // the user asked to be forgotten mid-merge

  const res = await persistDossierMerge(
    h,
    'they run a print shop and just hired two people',
    { epoch: epoch0, dossierMd: 'they run a print shop' },
  );
  assert.equal(res.dossierSaved, false);
  assert.equal(res.longSaved, false);
  assert.equal((await getMemory(h))?.dossierMd, '', 'the wipe stands');
});

test('long-doc version conflict + DIFFERENT content aborts (the empty forget revision survives)', async () => {
  const h = freshHandle();
  await saveLongDoc(h, '', 0, 'forget');   // the empty doc /forget leaves behind

  const attempts: number[] = [];
  const res = await persistDossierMerge(
    h,
    'a fully merged dossier',
    { epoch: getForgetEpoch(h), dossierMd: 'the doc this merge started from' },
    {
      saveLong: async (_h, _doc, expectedVersion) => { attempts.push(expectedVersion); return null; },
    },
  );
  assert.equal(res.dossierSaved, true, 'the legacy dossier still saved');
  assert.equal(res.longSaved, false);
  assert.equal(attempts.length, 1, 'no blind retry at the fresh version');
  assert.equal((await getLongDoc(h))?.docMd, '', 'the forget revision was NOT clobbered');
});

test('long-doc version conflict + UNCHANGED content retries once at the fresh version', async () => {
  const h = freshHandle();
  await saveLongDoc(h, 'the doc this merge started from', 0, 'dossier_llm');

  let calls = 0;
  const res = await persistDossierMerge(
    h,
    'a fully merged dossier',
    { epoch: getForgetEpoch(h), dossierMd: 'the doc this merge started from' },
    {
      saveLong: async (handle, doc, expectedVersion, writtenBy) => {
        calls++;
        if (calls === 1) return null;   // pure version drift — nobody changed the content
        return saveLongDoc(handle, doc, expectedVersion, writtenBy);
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(res.longSaved, true);
  const doc = await getLongDoc(h);
  assert.equal(doc?.docMd, 'a fully merged dossier');
  assert.equal(doc?.version, 2);
});

// ── The hot look, reported out of the context block ──────────────────────────
// buildContextBlock renders the memory tiers, and the short tier's hot-look verdict — the one
// held thing the memory stack proves touches this turn — used to die inside it. The turn-focus
// block names that look (agents/convo/turnFocus.ts), so it now travels back out. The string is
// unchanged either way, which is what these pin.

test('buildContextBlockWithHot reports the hot research look, and buildContextBlock still returns just the string', async () => {
  const h = freshHandle();
  await addShortTerm({ agentHandle: h, kind: 'ops_research', request: 'cedar lead times', content: 'x'.repeat(300) });

  const onTopic = await buildContextBlockWithHot(h, 'any word on cedar yet');
  assert.equal(onTopic.hotLook?.request, 'cedar lead times', 'the look that rendered in full is named');
  assert.ok(onTopic.block.includes('cedar lead times'));
  assert.equal(await buildContextBlock(h, 'any word on cedar yet'), onTopic.block, 'same bytes as ever');

  // Topic moved on → the full body left the prompt, so there is no hot look to name.
  const movedOn = await buildContextBlockWithHot(h, 'what should i cook for dinner');
  assert.equal(movedOn.hotLook, null);
  assert.equal(await buildContextBlock(h, 'what should i cook for dinner'), movedOn.block, 'same bytes as ever');
});

test('buildContextBlockWithHot reports no hot look when nothing is held at all', async () => {
  const h = freshHandle();
  const out = await buildContextBlockWithHot(h, 'any word on cedar yet');
  assert.equal(out.hotLook, null);
  assert.ok(out.block.length > 0, 'the memory stack still renders (the addressing rule alone)');
});

// ── The dossier fact guard (DOSSIER_FACT_GUARD_ENABLED, default ON) ──────────
// The rewrite is a full-document merge by a cheap model that never saw the medium tier, so it can
// write "goes by Mike" straight over a stored `address_as` of "Chief". Three keyed lines are now
// defended — what to call them, how to address them, how they text — line by line and no further.

async function withEnv<T>(name: string, value: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}
const withFactGuard = <T>(on: boolean, fn: () => Promise<T> | T) =>
  withEnv('DOSSIER_FACT_GUARD_ENABLED', on ? 'true' : 'false', fn);
const withProvenanceFlag = <T>(on: boolean, fn: () => Promise<T> | T) =>
  withEnv('MEMORY_PROVENANCE_ENABLED', on ? 'true' : 'false', fn);

/** A bundle with just the fact halves filled — the guard reads nothing else. */
function bundle(facts: Record<string, string>, factProv?: Record<string, Provenance>): MediumBundle {
  return { directives: [], notes: [], facts, ...(factProv ? { factProv } : {}) };
}

test('DOSSIER_FACT_GUARD_ENABLED is default ON, read at call time, parsed like its siblings', () => {
  const prior = process.env.DOSSIER_FACT_GUARD_ENABLED;
  try {
    delete process.env.DOSSIER_FACT_GUARD_ENABLED;
    assert.equal(dossierFactGuardEnabled(), true, 'unset → on');
    for (const v of ['true', '1', 'on', 'yes', 'ON', ' yes ']) {
      process.env.DOSSIER_FACT_GUARD_ENABLED = v;
      assert.equal(dossierFactGuardEnabled(), true, v);
    }
    for (const v of ['false', '0', 'off', 'no', 'nonsense']) {
      process.env.DOSSIER_FACT_GUARD_ENABLED = v;
      assert.equal(dossierFactGuardEnabled(), false, v);
    }
  } finally {
    if (prior === undefined) delete process.env.DOSSIER_FACT_GUARD_ENABLED;
    else process.env.DOSSIER_FACT_GUARD_ENABLED = prior;
  }
});

test('enforceKeyedFacts corrects the keyed lines the rewrite contradicted, and nothing else', () => {
  const md = [
    '## Who they are',
    'They go by Mike. Runs a print shop in east austin.',
    '## How to text them',
    'Comms style is chatty, lots of exclamation marks.',
    '## Their world',
    'Fixing up a lake cabin he calls "the shack".',
  ].join('\n');
  const out = enforceKeyedFactsWithChanges(md, { address_as: 'Chief', comms_style: 'clipped, lowercase' });
  assert.deepEqual(out.changed, ['address_as', 'comms_style']);
  assert.equal(out.md, [
    '## Who they are',
    'They go by Chief. Runs a print shop in east austin.',
    '## How to text them',
    'Comms style is clipped, lowercase.',
    '## Their world',
    'Fixing up a lake cabin he calls "the shack".',   // untouched: not a keyed line
  ].join('\n'));
  // The narrow pinned signature returns the document alone.
  assert.equal(enforceKeyedFacts(md, { address_as: 'Chief', comms_style: 'clipped, lowercase' }), out.md);
});

test('enforceKeyedFacts leaves a line that already AGREES exactly as it is', () => {
  const md = '## Who they are\nThey go by Chief.';
  const out = enforceKeyedFactsWithChanges(md, { address_as: 'chief' });   // compared case-insensitively
  assert.deepEqual(out.changed, []);
  assert.equal(out.md, md, 'byte-identical: agreement is not a change');
});

test('enforceKeyedFacts with nothing confirmed is the identity function', () => {
  const md = '## Who they are\nThey go by Mike.\nName: Michael';
  assert.equal(enforceKeyedFacts(md, {}), md);
  assert.deepEqual(enforceKeyedFactsWithChanges(md, {}).changed, []);
});

test('enforceKeyedFacts corrects a Name: line off the confirmed name', () => {
  const out = enforceKeyedFactsWithChanges('## Who they are\nName: Michael\nThey go by Chief.', { name: 'Riv', address_as: 'Chief' });
  assert.deepEqual(out.changed, ['name']);
  assert.equal(out.md, '## Who they are\nName: Riv\nThey go by Chief.');
});

test('an address line is NOT checked against the profile name — a nickname is new information', () => {
  // A stored `name` says what they are called on paper; it says nothing about what they want to be
  // called. "They go by Mike." with only `name: Michael` held is the dossier LEARNING the nickname,
  // not contradicting anything — so the addressing rule answers to `address_as` alone.
  const md = '## Who they are\nThey go by Mike.';
  const out = enforceKeyedFactsWithChanges(md, { name: 'Michael' });
  assert.deepEqual(out.changed, [], 'nothing was contradicted');
  assert.equal(out.md, md, 'byte-identical');
});

test('the keyed rules only read the section whose subject IS the user', () => {
  // "## Their world" is where the OTHER people in their life live, and a nickname line there is
  // about one of them. Scanning it turned their partner and their sister into the user.
  const md = [
    '## Who they are',
    'They go by Mike.',
    '',
    '## Their world',
    'Her partner goes by Sam.',
    'Their sister prefers to be called Liz, never Elizabeth.',
  ].join('\n');
  const out = enforceKeyedFactsWithChanges(md, { name: 'Michael', address_as: 'Chief' });
  assert.deepEqual(out.changed, ['address_as']);
  assert.equal(out.md, [
    '## Who they are',
    'They go by Chief.',
    '',
    '## Their world',
    'Her partner goes by Sam.',                                  // untouched: not the user
    'Their sister prefers to be called Liz, never Elizabeth.',   // untouched: not the user
  ].join('\n'));
});

test('a heading-less legacy doc still gets the whole-document guard', () => {
  // The sections are what scopes the rules, so a doc that has none of them (an old dossier, or a
  // merge that dropped its headings) keeps the original whole-document scan rather than no guard.
  const out = enforceKeyedFactsWithChanges('Goes by Mike.', { address_as: 'Chief' });
  assert.deepEqual(out.changed, ['address_as']);
  assert.equal(out.md, 'Goes by Chief.');
});

test('enforceKeyedFacts is line-level: it never touches a line it cannot read a value out of', () => {
  const md = [
    'Their name came up once and they brushed it off.',
    'He mentioned his brother Mike in passing.',
    'Style: he swears by index cards.',
    'Name: Michael, but the shop staff all call him something else',  // says more than the name
    'When the room is loud, call them by their first name and keep it short.',
    'Comms style is clipped; he hates small talk.',                   // a second clause follows
  ].join('\n');
  assert.equal(enforceKeyedFacts(md, { name: 'Riv', address_as: 'Chief', comms_style: 'lowercase' }), md);
});

test('enforceKeyedFacts corrects a quoted nickname, and leaves a quoted one that agrees', () => {
  assert.equal(enforceKeyedFacts('They go by "Mike".', { address_as: 'Chief' }), 'They go by Chief.');
  const agrees = 'They go by "Chief".';
  assert.equal(enforceKeyedFacts(agrees, { address_as: 'Chief' }), agrees, 'the quotes are wording, not a disagreement');
  // The accepted miss, pinned so nobody "fixes" it by loosening the value shape: an UNQUOTED
  // two-word nickname is left alone. Missing a correction costs one stale dossier line; a looser
  // rule costs a rewritten sentence about their life (see KEYED_FACT_LINES).
  assert.equal(enforceKeyedFacts('They go by Big Mike.', { address_as: 'Chief' }), 'They go by Big Mike.');
});

test('keyedFactsForDossier: with provenance ON only STATED facts are confirmed', async () => {
  await withProvenanceFlag(true, () => {
    const facts = keyedFactsForDossier(
      { handle: 'h', name: 'Riv', facts: [], firstSeen: 0, lastSeen: 0 },
      bundle({ address_as: 'Chief', comms_style: 'clipped' }, { address_as: 'stated', comms_style: 'inferred' }),
    );
    assert.deepEqual(facts.confirmed, { name: 'Riv', address_as: 'Chief' }, 'a guess is not a confirmation');
    assert.equal(facts.seedActive, false, 'no seeded row held');
  });
});

test('keyedFactsForDossier: with provenance OFF every keyed fact counts as stated', async () => {
  await withProvenanceFlag(false, () => {
    const facts = keyedFactsForDossier(
      null,
      bundle({ address_as: 'Chief', comms_style: 'clipped' }, { address_as: 'stated', comms_style: 'inferred' }),
    );
    // Nothing recorded who said what, so a durable keyed fact IS the confirmed value.
    assert.deepEqual(facts.confirmed, { address_as: 'Chief', comms_style: 'clipped' });
  });
});

test('keyedFactsForDossier reports a live seed row, and a stated override retiring it', () => {
  assert.equal(keyedFactsForDossier(null, bundle({ [SEED_FACT_KEY]: 'a lake cabin' }, { [SEED_FACT_KEY]: 'seeded' })).seedActive, true);
  assert.equal(
    keyedFactsForDossier(null, bundle({ [SEED_FACT_KEY]: 'a lake cabin' }, { [SEED_FACT_KEY]: 'stated' })).seedActive,
    false,
    'their own words retire the caveat',
  );
  assert.equal(keyedFactsForDossier(null, bundle({ brokerage: 'Compass' })).seedActive, false, 'never seeded at all');
});

test('reinjectSeedProvenance puts the line back into "## Who they are", and never twice', () => {
  const stripped = '## Who they are\nThey go by Chief.\n\n## Their world\nThe shack.';
  const first = reinjectSeedProvenance(stripped);
  assert.equal(first.outcome, 'reinjected');
  assert.equal(first.md, `## Who they are\nThey go by Chief.\n${PROVENANCE_LINE}\n\n## Their world\nThe shack.`);
  const again = reinjectSeedProvenance(first.md);
  assert.equal(again.outcome, 'kept');
  assert.equal(again.md, first.md, 'idempotent');
  const noSection = reinjectSeedProvenance('## Their world\nThe shack.');
  assert.equal(noSection.outcome, 'no_section');
  assert.equal(noSection.md, '## Their world\nThe shack.');
});

test('renderConfirmedFacts tells the merge model what it may not contradict, and vanishes when nothing is held', () => {
  assert.equal(renderConfirmedFacts({}), '', 'nothing held → the prompt this call always sent');
  const block = renderConfirmedFacts({ name: 'Riv', address_as: 'Chief', comms_style: 'clipped' });
  assert.equal(block, [
    '',
    '',
    "CONFIRMED FACTS (from durable memory — the user's own words; never contradict these, and prefer them over anything the transcript seems to say):",
    '- name: Riv',
    '- address as: Chief',
    '- comms style: clipped',
  ].join('\n'));
  // The keys render in KEYED_FACT_KEYS order, not in whatever order they were assigned.
  assert.equal(renderConfirmedFacts({ comms_style: 'clipped', name: 'Riv' }).indexOf('name'), block.indexOf('name'));
});

test('persistDossierMerge corrects the doc it writes, and the receipt names what it corrected', async () => {
  const h = freshHandle();
  await withFactGuard(true, async () => {
    clearTraces();
    const res = await persistDossierMerge(
      h,
      '## Who they are\nThey go by Mike.',
      { epoch: getForgetEpoch(h), dossierMd: '' },
      { facts: { confirmed: { address_as: 'Chief' }, seedActive: false } },
    );
    assert.equal(res.dossierSaved, true);
    assert.equal((await getMemory(h))?.dossierMd, '## Who they are\nThey go by Chief.', 'the doc that got STORED is the corrected one');
    assert.equal((await getLongDoc(h))?.docMd, '## Who they are\nThey go by Chief.', 'and so is the long-tier mirror');

    const d = (getTraces().find(e => e.label === 'memory:dossier_facts_enforced')?.detail ?? {}) as Record<string, unknown>;
    assert.deepEqual(d.changed, ['address_as']);
    assert.equal(d.enabled, true);
    assert.equal(d.provenanceLine, 'not_seeded');
  });
});

test('the clean case still leaves a receipt, with nothing changed', async () => {
  const h = freshHandle();
  await withFactGuard(true, async () => {
    clearTraces();
    await persistDossierMerge(
      h,
      '## Who they are\nThey go by Chief.',
      { epoch: getForgetEpoch(h), dossierMd: '' },
      { facts: { confirmed: { address_as: 'Chief' }, seedActive: false } },
    );
    const d = (getTraces().find(e => e.label === 'memory:dossier_facts_enforced')?.detail ?? {}) as Record<string, unknown>;
    assert.deepEqual(d.changed, [], 'the no-op is on the record too');
    assert.equal(d.confirmed, 1);
  });
});

test('a persist with no confirmed facts at all is still on the record', async () => {
  const h = freshHandle();
  await withFactGuard(true, async () => {
    clearTraces();
    await persistDossierMerge(h, '## Who they are\nThey go by Mike.', { epoch: getForgetEpoch(h), dossierMd: '' });
    const d = (getTraces().find(e => e.label === 'memory:dossier_facts_enforced')?.detail ?? {}) as Record<string, unknown>;
    assert.deepEqual(d.changed, []);
    assert.equal(d.confirmed, 0, 'nothing was held to check against');
  });
});

test('flag OFF: the doc is written exactly as the model wrote it, and the receipt says why', async () => {
  const h = freshHandle();
  await withFactGuard(false, async () => {
    clearTraces();
    await persistDossierMerge(
      h,
      '## Who they are\nThey go by Mike.',
      { epoch: getForgetEpoch(h), dossierMd: '' },
      { facts: { confirmed: { address_as: 'Chief' }, seedActive: true } },
    );
    assert.equal((await getMemory(h))?.dossierMd, '## Who they are\nThey go by Mike.', 'untouched — no correction, no provenance line');
    const d = (getTraces().find(e => e.label === 'memory:dossier_facts_enforced')?.detail ?? {}) as Record<string, unknown>;
    assert.equal(d.enabled, false);
    assert.deepEqual(d.changed, []);
    assert.equal(d.provenanceLine, 'guard_off', 'the receipt says the guard was off, not that nothing was seeded');
  });
});

test('the provenance line survives a rewrite that dropped it, while the seed row is still seeded', async () => {
  const h = freshHandle();
  await withFactGuard(true, async () => {
    clearTraces();
    await persistDossierMerge(
      h,
      '## Who they are\nThey go by Chief.',
      { epoch: getForgetEpoch(h), dossierMd: '' },
      { facts: { confirmed: {}, seedActive: true } },
    );
    assert.ok((await getMemory(h))?.dossierMd?.includes(PROVENANCE_LINE), 'second-hand stays labeled second-hand');
    const d = (getTraces().find(e => e.label === 'memory:dossier_facts_enforced')?.detail ?? {}) as Record<string, unknown>;
    assert.equal(d.provenanceLine, 'reinjected');
  });
});

test('persistDossierMerge labels the long-doc revision with the caller\'s own writtenBy', async () => {
  const h = freshHandle();
  const seen: string[] = [];
  await persistDossierMerge(
    h, 'a seeded first picture', { epoch: getForgetEpoch(h), dossierMd: '' },
    {
      writtenBy: 'engine_seed',
      saveLong: async (handle, doc, version, writtenBy) => { seen.push(writtenBy); return saveLongDoc(handle, doc, version, writtenBy); },
    },
  );
  assert.deepEqual(seen, ['engine_seed'], 'the seed is not a dossier_llm rewrite');
  assert.equal((await listLongRevisions(h))[0]?.writtenBy, 'engine_seed');
});
