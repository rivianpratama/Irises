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
import { DOSSIER_SYSTEM_PROMPT, buildDossierTranscript, dossierUpdateUsable, persistDossierMerge, formatDaySpan } from './dossier.js';
import { saveDossier, clearDossier, getMemory, getForgetEpoch } from '../db/repositories/memory.js';
import { getLongDoc, saveLongDoc } from '../db/repositories/memoryLong.js';

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
