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
import { DOSSIER_SYSTEM_PROMPT, buildDossierTranscript, dossierUpdateUsable } from './dossier.js';

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
