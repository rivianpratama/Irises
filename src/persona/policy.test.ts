// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The persona policy. Two things live in this module and both of them are prose, so these tests are
// about the properties the prose has to KEEP rather than about its sentences:
//
//   • ONE PERSON ON EVERY SURFACE. `renderPersonaBlock` returns the same bytes for all four lanes.
//     That is the whole reason the block was lifted out of four Context.md files, and the day a lane
//     grows a sentence of its own is the day the four-lane drift starts again.
//   • THE ANCHOR IS SIX BULLETS, IN EVERY COMBINATION. Three modes times two window bands is six
//     renderings, and promptPolicy.test.ts pins "six `- ` lines, zero digits" over whichever one the
//     turn produced — so it is pinned here over all six, where a bad paste is one file from the edit.
//   • NO DIGITS ANYWHERE IN IT. Not cosmetic: a number at the recency edge is a number she can read
//     out, and every number in her replies has to be one she actually saw.
//   • THE WINDOW ONLY MOVES THE COMMON BULLETS. A long transcript buys identity restatement, never a
//     different law for the turn.
//   • AND THE BLOCK STILL DESCRIBES NO ENVELOPE FIELD. The status contract owns the field list; a
//     field described in two places drifts in one.
//
// PURE, so there is no fixture and no clock here — every case is a call and a string.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_BLOCK, PERSONA_LANES, renderPersonaBlock,
  DRIFT_ANCHOR_HEADING, DRIFT_ANCHOR_LEAD, DRIFT_MODES, DRIFT_LONG_WINDOW_CHARS, renderDriftAnchor,
} from './policy.js';

/** The two window sizes every anchor case runs at: one character under the band, and the band. */
const SHORT_WINDOW = DRIFT_LONG_WINDOW_CHARS - 1;
const LONG_WINDOW = DRIFT_LONG_WINDOW_CHARS;

/** Every rendering the anchor has: three modes times two bands. */
const ANCHORS = DRIFT_MODES.flatMap(mode => [
  { name: `${mode} / short window`, mode, windowChars: SHORT_WINDOW },
  { name: `${mode} / long window`, mode, windowChars: LONG_WINDOW },
]);

// ── one person, four surfaces ────────────────────────────────────────────────

test('the block is byte-identical on all four lanes', () => {
  assert.deepEqual([...PERSONA_LANES], ['convo', 'composer', 'fallfirm', 'fallfirm_progress']);
  for (const lane of PERSONA_LANES) {
    assert.equal(
      renderPersonaBlock(lane), PERSONA_BLOCK,
      `${lane} renders a different persona block — the four surfaces are one person, and a lane-specific line here is the drift this module exists to stop`,
    );
  }
});

test('the block opens on its own heading and carries exactly one', () => {
  assert.ok(PERSONA_BLOCK.startsWith('## Who is typing, in every lane\n'));
  assert.equal(
    PERSONA_BLOCK.split('\n').filter(l => l.startsWith('## ')).length, 1,
    'a second `## ` heading inside the block would collide with the corpus uniqueness pin (clauseInventory.test.ts)',
  );
  assert.ok(!PERSONA_BLOCK.endsWith('\n'), 'no trailing newline: the callers join sections themselves');
});

/**
 * The ten envelope keys, MIRRORED from ENVELOPE_FIELDS (persona/status.ts) as literals rather than
 * imported — this module is a leaf and its test keeps that property, because importing status.ts to
 * read ten strings would drag the LLM client into the cheapest test in the repo. The corpus-wide
 * version of this rule loops over ENVELOPE_FIELDS itself (promptPolicy.test.ts), so the day a
 * field is added and this list is not, the corpus test still catches it; what this copy buys is the
 * failure landing in the file somebody just edited.
 */
const ENVELOPE_KEYS = [
  'mood_label', 'mood_shift', 'intent_mode', 'terminal_closure', 'epistemic_trigger', 'meta_prompt',
  'hook_kind', 'language_request', 'thread_note', 'thread_outcome',
] as const;

test('the block describes no envelope field — the status contract owns the list', () => {
  for (const key of ENVELOPE_KEYS) {
    assert.ok(
      !PERSONA_BLOCK.includes(`- \`${key}\``),
      `\`${key}\` is described as a bullet in the persona block — ENVELOPE_FIELDS owns it, and a field described twice drifts in one`,
    );
  }
  assert.ok(
    !PERSONA_BLOCK.includes('- `'),
    'the block has no backticked bullet at all, which is why no key can be described in one',
  );
});

// ── the drift anchor ─────────────────────────────────────────────────────────

test('the heading is the literal three test files hard-code', () => {
  assert.equal(DRIFT_ANCHOR_HEADING, '## Still the same Irises, this far down');
  assert.deepEqual([...DRIFT_MODES], ['task', 'hook', 'quiet']);
});

test('every mode and window renders heading, lead, then exactly six `- ` bullets', () => {
  for (const a of ANCHORS) {
    const lines = renderDriftAnchor(a.mode, a.windowChars).split('\n');
    assert.equal(lines[0], DRIFT_ANCHOR_HEADING, `${a.name}: heading first`);
    assert.equal(lines[1], DRIFT_ANCHOR_LEAD, `${a.name}: lead second`);
    assert.equal(lines.length, 8, `${a.name}: heading + lead + six bullets, nothing else`);
    const bullets = lines.slice(2);
    assert.equal(bullets.length, 6, `${a.name}: six bullets`);
    for (const b of bullets) assert.ok(b.startsWith('- '), `${a.name}: every bullet line starts with "- " (${b})`);
  }
});

test('no digit in any of the six renderings — numbers are spelled', () => {
  for (const a of ANCHORS) {
    const text = renderDriftAnchor(a.mode, a.windowChars);
    assert.ok(
      !/[0-9]/.test(text),
      `${a.name}: a digit at the recency edge is a number she can read out, and every number in her replies has to be one she saw`,
    );
  }
});

test('the window band moves the common bullets and nothing else', () => {
  for (const mode of DRIFT_MODES) {
    const short = renderDriftAnchor(mode, SHORT_WINDOW).split('\n');
    const long = renderDriftAnchor(mode, LONG_WINDOW).split('\n');

    assert.deepEqual(short.slice(0, 2), long.slice(0, 2), `${mode}: same heading and lead`);
    assert.deepEqual(short.slice(5), long.slice(5), `${mode}: the law for the turn does not move with the window`);
    assert.notDeepEqual(short.slice(2, 5), long.slice(2, 5), `${mode}: the long window restates identity`);

    // What the restatement actually buys, named rather than merely different.
    const restated = long.slice(2, 5).join('\n');
    assert.ok(restated.includes('You are Irises'), `${mode}: the long window says her name`);
    assert.ok(restated.includes('Never defend, never wink, never suck up'), `${mode}: and the three moves`);
  }
});

test('the band is inclusive at its edge, and the same arguments always give the same bytes', () => {
  const under = renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS - 1);
  const at = renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS);
  assert.notEqual(under, at, 'DRIFT_LONG_WINDOW_CHARS itself is a long window');
  assert.equal(at, renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS), 'deterministic — the goldens pin these bytes');
  assert.equal(renderDriftAnchor('quiet', 0), renderDriftAnchor('quiet', 1), 'and an empty window is just a short one');
});

test('each mode states its own law, and only its own', () => {
  const task = renderDriftAnchor('task', SHORT_WINDOW);
  const hook = renderDriftAnchor('hook', SHORT_WINDOW);
  const quiet = renderDriftAnchor('quiet', SHORT_WINDOW);

  assert.ok(task.includes('answer it flat, with the real numbers, and nothing else'));
  assert.ok(hook.includes('one hook, of a kind the hooks section above still allows, and only one'));
  assert.ok(quiet.includes('one plain short bubble, a tapback, or nothing'));

  // The mode bullets are disjoint: an anchor that carried two laws would be no anchor at all.
  assert.ok(!task.includes('This is an idle turn'));
  assert.ok(!hook.includes('This is a task turn'));
  assert.ok(!quiet.includes('This is a task turn') && !quiet.includes('This is an idle turn'));
});
