// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The pure engine behind the dossier LINE-EDIT protocol: number the document, read a small JSON op
// list back, verify each op against the line it claims, apply it, stamp it, and keep the result
// inside its budget. No DB, no env, no clock — `today` is an argument, so every case below reads as
// the specification it is.
//
// Why it exists: the dossier used to be rewritten whole by a cheap model, which meant (a) a reply
// that stopped mid-document deleted the tail, and (b) nothing could ever RESOLVE a contradiction —
// "Comfortable switching between English and Indonesian" and "Prefers English conversation" sat one
// under the other with no dates, so "more recent wins" had nothing to sort on.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVENANCE_LINE } from './provenance.js';
import {
  CANONICAL_HEADINGS, EDIT_MATCH_MIN_CHARS, EDIT_TEXT_MAX_CHARS, EDIT_MAX_OPS,
  LONG_DOC_MAX_WORDS, LONG_DOC_MAX_CHARS, STAMP_RE,
  numberDoc, parseEditOps, applyEditOps, normalizeDoc, splitStamp, stripEditStamps,
  docStats, overCap, evictOldest,
  type EditOp,
} from './dossierEdits.js';
import { MEMORY_LONG_MAX_CHARS } from './wrappers.js';

const TODAY = '2026-09-05';

/** The shape every apply case starts from: two canonical sections, the identity anchor, the
 *  provenance line, a blank separator, and one line that contradicts what the user has since
 *  said — line numbers in the assertions below refer to THIS document. */
const DOC = [
  '## Who they are',                                    // 1
  '- Sam, runs a plant nursery outside bend',           // 2
  PROVENANCE_LINE,                                      // 3
  '',                                                   // 4
  '## How to text them',                                // 5
  '- casual, lowercase, reads on the phone',            // 6
  '- prefers English conversation',                     // 7
  '',                                                   // 8
  '## Their world',                                     // 9
  '- the cedar order from the north supplier is late',  // 10
].join('\n');

const add = (section: string, text: string): EditOp =>
  ({ op: 'add', section: section as never, text });
const replace = (line: number, match: string, text: string): EditOp =>
  ({ op: 'replace', line, match, text });
const del = (line: number, match: string): EditOp => ({ op: 'delete', line, match });

const reasons = (r: Array<{ reason: string }>) => r.map(x => x.reason);

// ── the budget constants ─────────────────────────────────────────────────────

test('the edit budgets sit inside the render cap the sanitizer enforces', () => {
  assert.deepEqual([...CANONICAL_HEADINGS], [
    '## Who they are', '## How they work', '## How to text them', '## Their world', '## Running jokes',
  ]);
  assert.ok(LONG_DOC_MAX_CHARS < MEMORY_LONG_MAX_CHARS, 'a document at its budget always renders whole');
  assert.equal(EDIT_MATCH_MIN_CHARS, 12);
  assert.equal(EDIT_MAX_OPS, 12);
  assert.equal(LONG_DOC_MAX_WORDS, 450);
});

// ── numbering ────────────────────────────────────────────────────────────────

test('numberDoc numbers every line, blanks and headings included', () => {
  const { snapshot, lines } = numberDoc(DOC);
  assert.equal(lines.length, 10);
  const numbered = snapshot.split('\n');
  assert.equal(numbered.length, 10);
  assert.equal(numbered[0], '1| ## Who they are');
  assert.equal(numbered[3], '4| ', 'a blank line still burns a number — the model counts what it sees');
  assert.equal(numbered[6], '7| - prefers English conversation');
  assert.equal(numbered[9], '10| - the cedar order from the north supplier is late');
});

test('numberDoc on an empty document is empty, not a phantom line 1', () => {
  assert.deepEqual(numberDoc(''), { snapshot: '', lines: [] });
  assert.deepEqual(numberDoc('   \n  '), { snapshot: '', lines: [] });
});

// ── verification: the match is the proof the model means that line ───────────

test('a replace whose match copies the line rewrites it, stamped today', () => {
  const out = applyEditOps(DOC, [replace(7, 'prefers English', 'code-switches, and asked for English replies in September')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.applied.length, 1);
  assert.ok(out.doc.includes('- code-switches, and asked for English replies in September (since 2026-09-05)'));
  assert.ok(!out.doc.includes('- prefers English conversation'), 'the contradicting line is gone, not stacked under');
  assert.ok(out.doc.includes('- casual, lowercase, reads on the phone'), 'its neighbour is untouched');
});

test('a match that paraphrases the line, or is too short to prove anything, is discarded', () => {
  const wrong = applyEditOps(DOC, [replace(7, 'loves the telephone', 'texts in the evening')], TODAY);
  assert.deepEqual(reasons(wrong.rejected), ['match_mismatch']);
  assert.equal(wrong.doc, DOC, 'a rejected op leaves the document byte-identical');

  const short = applyEditOps(DOC, [replace(7, 'prefers', 'texts in the evening')], TODAY);
  assert.deepEqual(reasons(short.rejected), ['match_too_short']);
  assert.equal(short.doc, DOC);
});

test('the match is case-insensitive and whitespace-folded — a copy is a copy', () => {
  const out = applyEditOps(DOC, [del(10, 'THE   cedar order   from the north')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.ok(!out.doc.includes('cedar order'));
});

test('a line shorter than the match floor may be matched whole', () => {
  const doc = ['## Their world', '- kayaks'].join('\n');
  const out = applyEditOps(doc, [replace(2, '- kayaks', 'sold the kayak, bought a canoe')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.ok(out.doc.includes('- sold the kayak, bought a canoe (since 2026-09-05)'));
});

// ── one op per line, and which lines are off limits ──────────────────────────

test('a second op on the same line is refused — line numbers never shift mid-batch', () => {
  const out = applyEditOps(DOC, [
    replace(7, 'prefers English', 'asked for English in September'),
    del(7, 'prefers English'),
  ], TODAY);
  assert.deepEqual(reasons(out.rejected), ['line_already_edited']);
  assert.equal(out.applied.length, 1);
  assert.ok(out.doc.includes('- asked for English in September (since 2026-09-05)'));
});

test('line numbers resolve against the document the model was shown, not the one being built', () => {
  const out = applyEditOps(DOC, [
    del(6, 'casual, lowercase'),
    replace(7, 'prefers English', 'asked for English in September'),
  ], TODAY);
  assert.deepEqual(out.rejected, [], 'the delete above line 7 does not renumber line 7');
  assert.ok(!out.doc.includes('casual, lowercase'));
  assert.ok(out.doc.includes('- asked for English in September (since 2026-09-05)'));
});

test('headings, blank lines and the provenance line cannot be edited away', () => {
  for (const line of [1, 4, 3]) {
    const out = applyEditOps(DOC, [del(line, DOC.split('\n')[line - 1] || 'a blank line')], TODAY);
    assert.deepEqual(reasons(out.rejected), ['line_not_editable'], `line ${line}`);
    assert.equal(out.doc, DOC);
  }
  assert.ok(applyEditOps(DOC, [replace(3, 'first picture came from', 'they told me all this')], TODAY).doc.includes(PROVENANCE_LINE));
});

test('a line number off the end of the document is rejected, not clamped', () => {
  assert.deepEqual(reasons(applyEditOps(DOC, [del(99, 'the cedar order from')], TODAY).rejected), ['line_out_of_range']);
  assert.deepEqual(reasons(applyEditOps(DOC, [del(0, 'the cedar order from')], TODAY).rejected), ['line_out_of_range']);
});

// ── adds ─────────────────────────────────────────────────────────────────────

test('an add lands at the end of its section, and a missing heading is created in canonical order', () => {
  const out = applyEditOps(DOC, [
    add('## How they work', 'ships at night, reviews in the morning'),
    add('## Their world', 'bought a kayak in september'),
  ], TODAY);
  assert.deepEqual(out.rejected, []);
  const lines = out.doc.split('\n').filter(l => l.trim());
  const headings = lines.filter(l => l.startsWith('## '));
  assert.deepEqual(headings, ['## Who they are', '## How they work', '## How to text them', '## Their world']);
  assert.equal(lines[lines.indexOf('## How they work') + 1], '- ships at night, reviews in the morning (since 2026-09-05)');
  assert.equal(
    lines[lines.length - 1], '- bought a kayak in september (since 2026-09-05)',
    'an add appends BELOW the lines already in its section',
  );
});

test('an add to the last canonical section, with no heading yet, goes to the bottom', () => {
  const out = applyEditOps(DOC, [add('## Running jokes', 'the budget committee')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.ok(out.doc.endsWith('## Running jokes\n- the budget committee (since 2026-09-05)'));
});

test('an add names one of the five headings or it is discarded', () => {
  const out = applyEditOps(DOC, [add('## Their secrets', 'something')], TODAY);
  assert.deepEqual(reasons(out.rejected), ['unknown_section']);
  assert.equal(out.doc, DOC);
});

test('code owns the bullet, the newlines and the stamp — whatever the model writes', () => {
  const out = applyEditOps(DOC, [add('## Their world', '- bought a kayak\n  in september (since 2020-01-01)')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.ok(out.doc.includes('- bought a kayak in september (since 2026-09-05)'));
  assert.ok(!out.doc.includes('2020-01-01'), 'a model-written stamp is never trusted');
});

test('a line the document already holds is not added twice', () => {
  const dup = applyEditOps(DOC, [add('## How to text them', 'Casual,  lowercase, reads on the phone')], TODAY);
  assert.deepEqual(reasons(dup.rejected), ['duplicate']);
  assert.equal(dup.doc, DOC);

  const twice = applyEditOps(DOC, [
    add('## Their world', 'bought a kayak'),
    add('## Their world', 'bought a kayak'),
  ], TODAY);
  assert.deepEqual(reasons(twice.rejected), ['duplicate'], 'including twice inside one batch');
  assert.equal(twice.applied.length, 1);
});

test('an empty or oversized op text is refused', () => {
  assert.deepEqual(reasons(applyEditOps(DOC, [add('## Their world', '   ')], TODAY).rejected), ['empty_text']);
  assert.deepEqual(
    reasons(applyEditOps(DOC, [add('## Their world', 'x'.repeat(EDIT_TEXT_MAX_CHARS + 1))], TODAY).rejected),
    ['text_too_long'],
  );
});

test('only the lines the batch wrote carry a stamp', () => {
  const out = applyEditOps(DOC, [add('## Their world', 'bought a kayak')], TODAY);
  const stamped = out.doc.split('\n').filter(l => STAMP_RE.test(l));
  assert.deepEqual(stamped, ['- bought a kayak (since 2026-09-05)']);
  assert.ok(out.doc.includes('- Sam, runs a plant nursery outside bend'), 'an untouched line stays undated');
});

test('an empty document can be written into from nothing', () => {
  const out = applyEditOps('', [add('## Who they are', 'Sam, runs a plant nursery')], TODAY);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.doc, '## Who they are\n- Sam, runs a plant nursery (since 2026-09-05)');
});

test('a batch longer than the op ceiling keeps the first ops and reports the rest', () => {
  const ops = Array.from({ length: EDIT_MAX_OPS + 3 }, (_, i) => add('## Their world', `durable fact number ${i}`));
  const out = applyEditOps(DOC, ops, TODAY);
  assert.equal(out.applied.length, EDIT_MAX_OPS);
  assert.deepEqual(reasons(out.rejected), ['too_many_ops', 'too_many_ops', 'too_many_ops']);
});

// ── the stamp grammar ────────────────────────────────────────────────────────

test('splitStamp separates the body from its date, and leaves an undated line alone', () => {
  assert.deepEqual(splitStamp('- prefers English (since 2026-09-04)'), { body: '- prefers English', since: '2026-09-04' });
  assert.deepEqual(splitStamp('- prefers English'), { body: '- prefers English', since: null });
  assert.deepEqual(splitStamp('- shipped in 2026 (since then)'), { body: '- shipped in 2026 (since then)', since: null });
});

test('stripEditStamps is idempotent and a no-op on a document written before stamps existed', () => {
  const stamped = ['## Who they are', '- Sam, runs a nursery (since 2026-09-05)', '', '## Their world', '- kayaks (since 2026-01-02)'].join('\n');
  const once = stripEditStamps(stamped);
  assert.equal(once, ['## Who they are', '- Sam, runs a nursery', '', '## Their world', '- kayaks'].join('\n'));
  assert.equal(stripEditStamps(once), once);
  assert.equal(stripEditStamps(DOC), DOC, 'a legacy dossier passes through byte for byte');
  assert.equal(stripEditStamps(''), '');
});

// ── size ─────────────────────────────────────────────────────────────────────

/** The frozen LONG.md as it stood on the VPS the day this was diagnosed: 581 words in 3,608
 *  characters — over the WORD budget while comfortably inside the character one, which is the whole
 *  reason `overCap` reports which budget broke rather than a boolean. */
function frozenDossier(): string {
  const words = [...Array(458).fill('alpha'), ...Array(123).fill('bravox')] as string[];
  return words.map((w, i) => (i && i % 8 === 0 ? '\n' : ' ') + w).join('').trim();
}

test('docStats counts whitespace-separated words, and overCap names the budget that broke', () => {
  const frozen = frozenDossier();
  assert.deepEqual(docStats(frozen), { words: 581, chars: 3608 });
  assert.equal(overCap(frozen), 'words');
  assert.equal(overCap(DOC), null);
  assert.equal(overCap(`- ${'x'.repeat(LONG_DOC_MAX_CHARS)}`), 'chars', 'one unspaced blob breaks the char budget alone');
});

// ── normalization ────────────────────────────────────────────────────────────

test('normalizeDoc puts the sections in canonical order, drops scope, and relocates the rest', () => {
  const messy = [
    '## Running jokes',
    '- the budget committee',
    '',
    '## Scope',
    '- cannot read your email',
    '',
    '## Their people',
    '- ada does the deliveries',
    '- theo covers weekends',
    '',
    '## Who they are',
    '- Sam, runs a plant nursery',
  ].join('\n');
  const out = normalizeDoc(messy);
  assert.equal(out.doc, [
    '## Who they are',
    '- Sam, runs a plant nursery',
    '',
    '## Their world',
    '- ada does the deliveries',
    '- theo covers weekends',
    '',
    '## Running jokes',
    '- the budget committee',
  ].join('\n'));
  assert.deepEqual(out.relocated, ['- ada does the deliveries', '- theo covers weekends']);
  assert.deepEqual(out.droppedScope, ['## Scope']);
  assert.ok(!out.doc.includes('cannot read your email'), 'a dossier never dictates what she refuses');
});

test('normalizeDoc is a no-op on a document already in shape', () => {
  const out = normalizeDoc(DOC);
  assert.equal(out.doc, DOC);
  assert.deepEqual(out.relocated, []);
  assert.deepEqual(out.droppedScope, []);
});

test('normalizeDoc merges two copies of the same heading instead of keeping both', () => {
  const out = normalizeDoc(['## Their world', '- kayaks', '', '## Their world', '- the cedar order'].join('\n'));
  assert.equal(out.doc, ['## Their world', '- kayaks', '- the cedar order'].join('\n'));
});

// ── eviction ─────────────────────────────────────────────────────────────────

/** Over budget, with the three eviction tie-breaks lined up inside "## Running jokes": one undated
 *  line, one stamped in January, one stamped in May. Undated goes first (it predates every stamp),
 *  then ascending date. */
const OVER = [
  '## Who they are',
  '- Sam, runs a plant nursery outside bend',
  PROVENANCE_LINE,
  '',
  '## How they work',
  '- ships at night, reviews in the morning',
  '',
  '## Running jokes',
  '- the budget committee, their own name for a third price comparison',
  '- the shack, what they call the lake cabin (since 2026-01-02)',
  `- ${'the long-running bit about the cedar order '.repeat(90)}(since 2026-05-05)`,
].join('\n');

test('evictOldest sheds the last sections first, undated before dated, until the doc fits', () => {
  assert.ok(overCap(OVER) !== null);
  const out = evictOldest(OVER);
  assert.equal(overCap(out.doc), null);
  assert.deepEqual(out.evicted.map(e => e.since), [null, '2026-01-02', '2026-05-05']);
  assert.deepEqual(out.evicted.map(e => e.section), ['## Running jokes', '## Running jokes', '## Running jokes']);
  assert.equal(out.evicted[1].text, 'the shack, what they call the lake cabin', 'the archived text carries no stamp and no bullet');
  assert.ok(out.doc.includes('- Sam, runs a plant nursery outside bend'), 'who they are is never evicted');
  assert.ok(out.doc.includes(PROVENANCE_LINE), 'nor is where the picture came from');
  assert.ok(out.doc.includes('- ships at night, reviews in the morning'));
  assert.ok(!out.doc.includes('## Running jokes'), 'an emptied heading goes with its last line');
});

test('evictOldest gives up rather than touch the identity section', () => {
  const huge = ['## Who they are', `- ${'x'.repeat(LONG_DOC_MAX_CHARS + 500)}`].join('\n');
  const out = evictOldest(huge);
  assert.deepEqual(out.evicted, []);
  assert.equal(out.doc, huge);
});

test('evictOldest is a no-op on a document already inside its budget', () => {
  const out = evictOldest(DOC);
  assert.equal(out.doc, DOC);
  assert.deepEqual(out.evicted, []);
});

// ── parsing what the model sent back ─────────────────────────────────────────

test('parseEditOps digs the op list out of fences and prose', () => {
  const body = '{"ops":[{"op":"add","section":"## Their world","text":"bought a kayak in september"}]}';
  for (const raw of ['```json\n' + body + '\n```', 'Sure — here you go: ' + body + ' hope that helps', body]) {
    const parsed = parseEditOps(raw);
    assert.ok(parsed, raw);
    assert.deepEqual(parsed.rejected, []);
    assert.deepEqual(parsed.ops, [{ op: 'add', section: '## Their world', text: 'bought a kayak in september' }]);
  }
});

test('parseEditOps runs the jsonrepair ladder for a nearly-valid reply', () => {
  const parsed = parseEditOps('{"ops":[{"op":"delete","line":7,"match":"prefers English",},]}');
  assert.ok(parsed);
  assert.deepEqual(parsed.ops, [{ op: 'delete', line: 7, match: 'prefers English' }]);
});

test('parseEditOps returns null when nothing usable came back at all', () => {
  for (const raw of [
    null,
    '',
    'no idea what you want',
    '{"ops":[{"op":"add","section":"## Their world","text":"bought a ka',   // truncated mid-object
    '{"notes":[]}',                                                        // an object, but not this protocol
    '{"ops":"none"}',
  ]) {
    assert.equal(parseEditOps(raw), null, String(raw));
  }
});

test('parseEditOps keeps the good ops and reports the bad ones', () => {
  const parsed = parseEditOps(JSON.stringify({
    ops: [
      { op: 'add', section: 'How to text them', text: 'texts in the evening' },   // heading without the hashes
      { op: 'rewrite', line: 2, text: 'nope' },
      { op: 'replace', line: 'seven', match: 'prefers English', text: 'nope' },
      { op: 'delete', line: 7 },
      { op: 'add', section: '## Their world', text: '' },
      'not an object',
    ],
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.ops, [{ op: 'add', section: '## How to text them', text: 'texts in the evening' }]);
  assert.deepEqual(reasons(parsed.rejected), ['bad_shape', 'bad_shape', 'bad_shape', 'empty_text', 'bad_shape']);
});

test('parseEditOps reports a deliberate no-op as an empty list, never as a failure', () => {
  assert.deepEqual(parseEditOps('{"ops":[]}'), { ops: [], rejected: [] });
});

test('parseEditOps caps the batch', () => {
  const parsed = parseEditOps(JSON.stringify({
    ops: Array.from({ length: EDIT_MAX_OPS + 2 }, (_, i) => ({ op: 'add', section: '## Their world', text: `fact ${i}` })),
  }));
  assert.ok(parsed);
  assert.equal(parsed.ops.length, EDIT_MAX_OPS);
  assert.deepEqual(reasons(parsed.rejected), ['too_many_ops', 'too_many_ops']);
});

test('a parsed batch survives the round trip into the document', () => {
  const parsed = parseEditOps('{"ops":[{"op":"replace","line":7,"match":"prefers English conversation","text":"asked for English replies on sep 4"}]}');
  assert.ok(parsed);
  const out = applyEditOps(DOC, parsed.ops, TODAY);
  assert.deepEqual(out.rejected, []);
  assert.ok(out.doc.includes('- asked for English replies on sep 4 (since 2026-09-05)'));
  assert.equal(overCap(out.doc), null);
});
