// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The pure half of the thesis feature: the document grammar, the validator, the weekly window and
// the dyn section. Everything here is a function of its arguments — no clock, no disk, no lane —
// so every case is a table row rather than a scenario.
//
// What the tests are really guarding:
//
//   • THE GRAMMAR ROUND-TRIPS. split(join(x)) === x for every shape the file can hold, including
//     the two lopsided ones (a read with no notes, notes with no read), because the nightly pass
//     and the weekly pass write through opposite halves of it.
//   • THE CAP HOLDS AT THE SEAM. `join` is the only door every writer passes through, so the
//     seven-note FIFO is enforced there and not only where a note is appended.
//   • STRUCTURE ONLY. The validator refuses a read for its length, its shape or its punctuation
//     count — never for a word it contains. The negative cases below include reads that a lexicon
//     would have refused ("competence", "money") and they are all accepted, on purpose.
//   • THE WINDOW IS A RATCHET. A row already read by last week's rewrite can never be read again,
//     and an undated row cannot slip past the cut by being undated.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THESIS_COOLDOWN_MS, THESIS_MIN_USER_LINES, THESIS_MIN_CHARS, THESIS_MAX_CHARS,
  THESIS_MAX_SENTENCES, THESIS_EVIDENCE_MAX, THESIS_EVIDENCE_NOTE_MAX, THESIS_EVIDENCE_HEADING,
  THESIS_SECTION_HEADING,
  countSentences, validateThesis, splitThesisDoc, joinThesisDoc, buildThesisWindow,
  renderThesisSection, type ThesisRejection,
} from './thesisEngine.js';
import { groupHandle } from './identity.js';
import { MOMENT_TEXT_MAX } from '../persona/moments.js';
import type { StoredMessage } from '../db/types.js';

const H = '+15551230001';
const OTHER = '+15559990002';
const T0 = Date.UTC(2026, 3, 1);
const HOUR = 60 * 60 * 1000;

/** A read that passes every structural check: two sentences, behaviour only, inside the bounds. */
const GOOD = 'They decide fast on things that cost money and slowly on things that cost a conversation. They would rather re-do a job than ask someone to fix it.';

// ── The constants ────────────────────────────────────────────────────────────

test('the constants are the numbers the plan and the writer prompt agree on', () => {
  assert.equal(THESIS_COOLDOWN_MS, 6.5 * 24 * 60 * 60 * 1000);
  // Half a day of slack, for the reason the climate cooldown is 22h: a weekly texter must not land
  // just inside the gate and skip every second rewrite.
  assert.ok(THESIS_COOLDOWN_MS < 7 * 24 * 60 * 60 * 1000);
  assert.equal(THESIS_MIN_USER_LINES, 20);
  assert.equal(THESIS_MIN_CHARS, 40);
  assert.equal(THESIS_MAX_CHARS, 600);
  assert.equal(THESIS_MAX_SENTENCES, 4);
  assert.equal(THESIS_EVIDENCE_MAX, 7);
  // Seven nightly notes is exactly one rewrite window — anything older is already in the read.
  assert.ok(THESIS_EVIDENCE_MAX * 24 * 60 * 60 * 1000 > THESIS_COOLDOWN_MS);
  // A note is one observation, the size the sibling store gives one moment line — the nightly pass
  // writes a moment and a note in ONE call, so two different caps would be an accident.
  assert.equal(THESIS_EVIDENCE_NOTE_MAX, 200);
  assert.equal(THESIS_EVIDENCE_NOTE_MAX, MOMENT_TEXT_MAX);
  assert.ok(THESIS_EVIDENCE_NOTE_MAX < THESIS_MAX_CHARS, 'a note is evidence for a read, never a read');
});

// ── countSentences ───────────────────────────────────────────────────────────

test('countSentences counts thoughts, not full stops', () => {
  const rows: [string, number][] = [
    ['', 0],
    ['   ', 0],
    ['one thought', 1],
    ['one thought.', 1],
    ['one. two.', 2],
    ['one. two', 2],
    ['one! two? three.', 3],
    ['a. b. c. d. e.', 5],
    // A number inside a read is allowed (unlike the hooks section, which is pinned digit-free), so
    // the dot in a decimal must not read as a sentence break.
    ['they gave it 3.5 hours and then quit.', 1],
    ['they send wa.me links instead of asking.', 1],
    // A run of terminators is one break, not three.
    ['really?! then nothing.', 2],
    // The documented cost: an ellipsis reads as a break. A read with one in it is already two
    // thoughts, so the ceiling catching it is the right direction — and both spellings of one
    // count the same, because a model writing `…` and a model writing `...` mean it identically.
    ['they start… then stop.', 2],
    ['they start... then stop.', 2],
  ];
  for (const [text, want] of rows) assert.equal(countSentences(text), want, text);
});

// ── validateThesis ───────────────────────────────────────────────────────────

test('a real read is accepted and comes back as one collapsed line', () => {
  const v = validateThesis(`  They decide fast on money.\n\n  They decide slowly on people, which is why the disputes sit open.  `);
  assert.ok(v.ok);
  assert.equal(v.text, 'They decide fast on money. They decide slowly on people, which is why the disputes sit open.');
  // What is saved is what was validated: the file can never hold a read the grammar cannot split.
  assert.ok(!v.text.includes('\n'));
});

test('every structural refusal, and the reason it reports', () => {
  const rows: [unknown, ThesisRejection][] = [
    [undefined, 'empty'],
    [null, 'empty'],
    [42, 'empty'],
    ['', 'empty'],
    ['   \n  ', 'empty'],
    // A lane with nothing to say writes the WORD. Reported as its own reason and NOT as too_short,
    // which is the ordering this list exists to pin.
    ['none', 'null_literal'],
    ['  N/A ', 'null_literal'],
    ['NULL', 'null_literal'],
    // …but a read that merely opens with one of those words is a read.
    // (positive case asserted below)
    [`${GOOD} <thesis>`, 'markup'],
    [`They keep {placeholders} in their asks and never fill them in themselves at all.`, 'markup'],
    ['They ship `git push --force` at midnight and then ask why the branch moved.', 'markup'],
    ['They overthink it.', 'too_short'],
    [`${'a '.repeat(THESIS_MAX_CHARS)}end.`, 'too_long'],
    [`${GOOD} And a third. And a fourth. And a fifth one too.`, 'too_many_sentences'],
  ];
  for (const [input, reason] of rows) {
    const v = validateThesis(input);
    assert.ok(!v.ok, `expected a refusal for ${JSON.stringify(input)}`);
    assert.equal(v.reason, reason, JSON.stringify(input));
  }
});

test('the bounds are inclusive at both edges', () => {
  const atMin = 'x'.repeat(THESIS_MIN_CHARS);
  const atMax = 'x'.repeat(THESIS_MAX_CHARS);
  assert.equal(validateThesis(atMin).ok, true);
  assert.equal(validateThesis(atMax).ok, true);
  assert.deepEqual(validateThesis('x'.repeat(THESIS_MIN_CHARS - 1)), { ok: false, reason: 'too_short' });
  assert.deepEqual(validateThesis('x'.repeat(THESIS_MAX_CHARS + 1)), { ok: false, reason: 'too_long' });
  // Exactly four sentences stands; a fifth does not.
  assert.equal(validateThesis('One thing they do. And another. And a third one. And a fourth one.').ok, true);
});

test('THERE IS NO WORD LIST: the validator judges shape and nothing else', () => {
  // The user rule this whole build is held to. Every read below is one a banned-word lexicon would
  // plausibly have refused — a feeling word, a body word inside a behavioural clause, a number, a
  // "none" that opens a real sentence — and each is a legitimate read of somebody. What a read may
  // be ABOUT lives in the writer prompt (docs/superpowers/prose/.../writer-prompts.md), which is
  // the only reader that can tell "reads a schedule question as a competence question" from an
  // insult about somebody's competence.
  const reads = [
    'They read a question about the schedule as a question about their competence, every time.',
    'None of their deadlines are real, and they know it by Wednesday and say so by Friday.',
    'They will sit on a decision for 3 weeks and then make it in an afternoon, badly.',
    'They mention being tired as a way of ending a conversation they have already decided.',
    'They are funnier when they are annoyed, and they are annoyed about the supplier again.',
  ];
  for (const r of reads) assert.equal(validateThesis(r).ok, true, r);
});

// ── the document grammar ─────────────────────────────────────────────────────

test('split and join round-trip every shape the file can hold', () => {
  const shapes: { thesis: string; evidence: string[] }[] = [
    { thesis: '', evidence: [] },
    { thesis: GOOD, evidence: [] },
    { thesis: GOOD, evidence: ['asked twice about the volcano again'] },
    { thesis: GOOD, evidence: ['note one', 'note two', 'note three'] },
    // A wipe followed by one nightly note: notes with no read. The tail still parses.
    { thesis: '', evidence: ['first note after the wipe'] },
  ];
  for (const shape of shapes) {
    const doc = joinThesisDoc(shape.thesis, shape.evidence);
    assert.deepEqual(splitThesisDoc(doc), shape, JSON.stringify(shape));
  }
});

test('an empty document is empty bytes — a person with no read has no file content', () => {
  assert.equal(joinThesisDoc('', []), '');
  assert.equal(joinThesisDoc('   ', ['  ', '']), '');
  assert.deepEqual(splitThesisDoc(''), { thesis: '', evidence: [] });
});

test('the document looks the way the plan writes it', () => {
  assert.equal(
    joinThesisDoc('the read', ['note a', 'note b']),
    `the read\n\n${THESIS_EVIDENCE_HEADING}\n- note a\n- note b`,
  );
});

test('join is the seam the seven-note FIFO is enforced at', () => {
  // Every write to this file is whole-document, so the cap has to hold for ANY writer that reaches
  // the seam — not only for the one append path that also slices.
  const many = Array.from({ length: 12 }, (_, i) => `note ${i + 1}`);
  const { evidence } = splitThesisDoc(joinThesisDoc(GOOD, many));
  assert.equal(evidence.length, THESIS_EVIDENCE_MAX);
  assert.deepEqual(evidence, many.slice(-THESIS_EVIDENCE_MAX), 'the NEWEST seven survive, oldest first');
  assert.equal(evidence[0], 'note 6');
  assert.equal(evidence[evidence.length - 1], 'note 12');
});

test('and LENGTH is enforced at the same seam — the notes are the weekly prompt input', () => {
  // Count is not the only way a tail gets too big. A model that answered with a paragraph, or a
  // human who typed into the tail, would otherwise ride into the rewrite prompt unbounded: the
  // store bounds nothing it did not write itself, so this is the only place it can hold.
  const long = `${'word '.repeat(200)}tail`;
  const [note] = splitThesisDoc(joinThesisDoc(GOOD, [long])).evidence;
  assert.ok(note.length <= THESIS_EVIDENCE_NOTE_MAX, `${note.length} chars kept`);
  assert.ok(long.startsWith(note), 'it is a prefix of the note, not a rewrite of it');
  assert.ok(note.split(' ').every(w => w === 'word'), 'cut on a word boundary');
  // A note inside the cap is untouched, and the read above the tail is NOT held to a note's cap.
  const exact = 'y'.repeat(THESIS_EVIDENCE_NOTE_MAX);
  assert.deepEqual(splitThesisDoc(joinThesisDoc(GOOD, [exact])), { thesis: GOOD, evidence: [exact] });
  const overNote = 'z'.repeat(THESIS_EVIDENCE_NOTE_MAX + 60);
  assert.equal(splitThesisDoc(joinThesisDoc(overNote, [])).thesis, overNote);
});

test('a note is collapsed to one line, because the tail is line-oriented', () => {
  const doc = joinThesisDoc(GOOD, ['they said\nthis over\n\ntwo lines']);
  assert.equal(doc.split('\n').filter(l => l.startsWith('- ')).length, 1);
  assert.deepEqual(splitThesisDoc(doc).evidence, ['they said this over two lines']);
});

test('splitting reads the FIRST heading, keeps a multi-line read, and drops only tail junk', () => {
  const doc = [
    'line one of the read',
    'line two of the read',
    '',
    THESIS_EVIDENCE_HEADING,
    '- kept note',
    'a hand-typed line in the tail',
    '   - indented note   ',
    '',
    THESIS_EVIDENCE_HEADING,
    '- note after a second heading',
  ].join('\n');
  const parts = splitThesisDoc(doc);
  assert.equal(parts.thesis, 'line one of the read\nline two of the read');
  // The tail is machine-written: a non-bullet line in it is dropped rather than guessed at, and a
  // human's own words belong ABOVE the boundary, where they are preserved verbatim.
  assert.deepEqual(parts.evidence, ['kept note', 'indented note', 'note after a second heading']);
});

test('a body with no heading is all read', () => {
  assert.deepEqual(splitThesisDoc('  just a read, no notes yet  '), { thesis: 'just a read, no notes yet', evidence: [] });
  // A heading that is only part of a line is not the boundary.
  const inline = 'they treat every ## evidence request as an accusation';
  assert.deepEqual(splitThesisDoc(inline), { thesis: inline, evidence: [] });
  // A nothing that slipped past the type degrades, in BOTH branches — the no-heading branch is the
  // one a null actually reaches, and it used to dereference the argument it had just defaulted.
  for (const nothing of [undefined, null] as unknown as string[]) {
    assert.deepEqual(splitThesisDoc(nothing), { thesis: '', evidence: [] });
  }
});

// ── buildThesisWindow ────────────────────────────────────────────────────────

const rows = (at: number): StoredMessage[] => [
  { role: 'user', content: 'theirs', handle: H, at },
  { role: 'assistant', content: 'hers', at: at + 1 },
];

test('the window is scoped to this user, cut at the last rewrite, and capped to the newest rows', () => {
  const cut = T0;
  const window = [
    ...rows(cut - HOUR),                                                    // ALREADY READ
    { role: 'user' as const, content: 'someone else', handle: OTHER, at: cut + HOUR },
    ...rows(cut + 2 * HOUR),
    ...rows(cut + 3 * HOUR),
  ];
  const out = buildThesisWindow(H, window, cut, 30);
  assert.ok(!out.some(m => m.at! <= cut), 'a row last week already read is never read again');
  assert.ok(!out.some(m => m.content === 'someone else'), 'another participant never feeds her read of this one');
  assert.equal(out.length, 4);

  // The cap keeps the NEWEST rows.
  const capped = buildThesisWindow(H, window, cut, 2);
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map(m => m.at), [cut + 3 * HOUR, cut + 3 * HOUR + 1]);
});

test('the cut is unconditional: an undated row cannot slip past it', () => {
  const undated: StoredMessage[] = [{ role: 'user', content: 'undated', handle: H }];
  assert.equal(buildThesisWindow(H, undated, T0, 30).length, 0);
  assert.equal(buildThesisWindow(H, undated, 0, 30).length, 0);
});

test('a first rewrite reads everything, and a garbage cap bills nothing', () => {
  const window = [...rows(T0), ...rows(T0 + HOUR)];
  assert.equal(buildThesisWindow(H, window, 0, 30).length, 4);
  // A non-finite or negative cap yields an empty window, which the pass then skips on its user-line
  // floor — failing toward "no call billed" rather than "a week of transcript in one prompt".
  assert.equal(buildThesisWindow(H, window, 0, Number.NaN).length, 0);
  assert.equal(buildThesisWindow(H, window, 0, -5).length, 0);
  assert.equal(buildThesisWindow(H, window, 0, 0).length, 0);
  assert.equal(buildThesisWindow(H, window, 0, 3.9).length, 3, 'a fractional cap truncates');
});

test('a group handle is not filtered, because a group read is not a person read', () => {
  // scopeHistoryToUser passes a group window through untouched; the PASS refuses group handles at
  // the door (the same fence every per-person memory writer carries). This pins the shape rather
  // than the policy: nothing here silently attributes a room to one member.
  const g = groupHandle('chat-1');
  const mixed: StoredMessage[] = [
    { role: 'user', content: 'a', handle: H, at: T0 + 1 },
    { role: 'user', content: 'b', handle: OTHER, at: T0 + 2 },
  ];
  assert.equal(buildThesisWindow(g, mixed, T0, 30).length, 2);
});

// ── renderThesisSection ──────────────────────────────────────────────────────

test('the section is the fixed heading and the read, one line each', () => {
  const out = renderThesisSection(GOOD);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], THESIS_SECTION_HEADING);
  assert.equal(lines[1], GOOD);
  // The heading is a literal, and every clause of it is load-bearing.
  assert.equal(
    THESIS_SECTION_HEADING,
    '## Your read on them (INTERNAL — never recite, never name; every judgment is made of it)',
  );
});

test('nothing to say renders NOTHING — the byte-identity law', () => {
  for (const empty of ['', '   ', '\n\n', undefined as unknown as string]) {
    assert.equal(renderThesisSection(empty), '');
  }
});

test('the render seam collapses and clamps, so no file can ride unbounded into the prompt', () => {
  // A read written before a bound moved, or a human who opened THESIS.md and typed: the store
  // cannot validate either, and this section is in every Convo turn for a week.
  const long = `${'word '.repeat(400)}tail`;
  const rendered = renderThesisSection(long);
  const body = rendered.split('\n')[1];
  assert.ok(body.length <= THESIS_MAX_CHARS);
  assert.ok(!body.endsWith(' '), 'the clamp cuts at a word boundary, never mid-gap');
  assert.ok(body.split(' ').every(w => w === 'word'), 'and never mid-word');
  assert.equal(renderThesisSection('one\nread\nover lines').split('\n').length, 2);

  // The documented exception: one token with no space inside the cap is cut HARD (persona/moments.ts
  // `clampMomentText`, same rule). A six-hundred-character word is a model malfunction, and keeping
  // it whole would defeat the cap it arrived at.
  const unbroken = 'x'.repeat(THESIS_MAX_CHARS + 50);
  assert.equal(renderThesisSection(unbroken).split('\n')[1], 'x'.repeat(THESIS_MAX_CHARS));
  const exact = 'y'.repeat(THESIS_MAX_CHARS);
  assert.equal(renderThesisSection(exact).split('\n')[1], exact, 'a read exactly at the bound is untouched');
});

test('a whole DOCUMENT renders only its read — the tail never reaches a prompt', () => {
  // The caller's line is `splitThesisDoc(doc.docMd).thesis`, and one caller writing `doc.docMd`
  // instead would put seven machine notes — 200 characters each — into a measured section on every
  // Convo turn for a week. Splitting again here is free, and the output is identical for every read
  // the store validates, so the contract holds rather than merely being written down.
  const doc = joinThesisDoc(GOOD, ['they asked about the volcano again', 'they re-did the job alone']);
  assert.equal(renderThesisSection(doc), renderThesisSection(GOOD));
  assert.equal(renderThesisSection(doc).split('\n').length, 2);
  assert.ok(!renderThesisSection(doc).includes(THESIS_EVIDENCE_HEADING));
  assert.ok(!renderThesisSection(doc).includes('volcano'));
  // A document whose read was wiped and whose tail is still filling renders NOTHING, not a heading
  // over somebody's notes.
  assert.equal(renderThesisSection(joinThesisDoc('', ['a note after the wipe'])), '');
});
