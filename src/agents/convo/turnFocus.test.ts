// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The turn-focus block: the last thing inside <prompt>, and the only place in a ~45k-char system
// prompt that says "answer what they just said". Two halves are tested here:
//
//   • the pure renderer + the shape classifier (no clock, no DB, no LLM) — a table of real messages
//     against their classified shape, the two length caps, the hit cap, and the no-hits line;
//   • the PLACEMENT, through the real assembler on four different turn shapes (plain, burst, tapped
//     reply, caller addendum): the block must be the last dyn section by `sections` order AND the
//     last thing before `</prompt>` by string position. Charter §11.3 is that placement rule, and
//     "last" is the whole mechanism — a restatement the model reads before anything of hers.
//
// Sibling of promptSections.test.ts and built the same way: buildSystemPromptSections is called
// directly, nothing here reaches a lane, a DB, or the selection engine.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTurnShape, renderTurnFocus, renderedTurnFocusHits, turnFocusBlockEnabled,
  TURN_SHAPES, TURN_FOCUS_TEXT_CHARS, TURN_FOCUS_LABEL_CHARS, TURN_FOCUS_MAX_HITS,
  type TurnShape, type TurnFocusInput, type TurnFocusHit,
} from './turnFocus.js';
import { buildSystemPrompt, buildSystemPromptSections } from './shared.js';
import { DYN_SECTION_IDS } from './promptSections.js';
import { PROMPT_TAG } from '../../llm/promptTag.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// ── a frozen clock ───────────────────────────────────────────────────────────
// The assembler reads the wall clock for the "Current time" section, so two builds compared for
// byte-identity have to happen at the same instant. Pinned by hand rather than with node:test's
// MockTimers, which prints an ExperimentalWarning (this suite runs warning-free).
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// ── the shape classifier ─────────────────────────────────────────────────────

/** Real messages, and the shape code must read off them. The six named in the plan plus enough
 *  neighbours to pin the precedence between the rules (a `?` beating a sign-off word, an imperative
 *  lead beating a bare statement, a closing word beating a greeting word). */
const SHAPE_TABLE: Array<[string, TurnShape]> = [
  ['hey', 'greeting'],
  ['good morning', 'greeting'],
  ['ok thanks', 'ack'],
  ['gotcha', 'ack'],
  ["what's 15% of 80", 'question'],
  ['why is the cedar order late?', 'question'],
  ['look up flights to tokyo', 'work_ask'],
  ['remind me to call the supplier at 4', 'work_ask'],
  ['ugh long day', 'statement'],
  ['i signed the lease on the second unit this morning', 'statement'],
  ['night, talk tomorrow', 'closing'],
  ['gotta run, bye', 'closing'],
  // Precedence: a question mark outranks the sign-off word that is also in the text.
  ['night, you around tomorrow?', 'question'],
  // A fronted auxiliary behind one token of discourse glue, with no question mark typed — the
  // commonest way a real text asks something.
  ['so are they coming or not', 'question'],
  ['hey check the cedar order', 'work_ask'],
  // Nothing said at all (a media-only turn's note is what actually arrives here) — the neutral default.
  ['', 'statement'],
];

test('classifyTurnShape reads the shape off the message, in code', () => {
  for (const [text, shape] of SHAPE_TABLE) {
    assert.equal(classifyTurnShape(text), shape, `"${text}" is a ${shape}`);
  }
});

test('classifyTurnShape is deterministic, total, and case/whitespace insensitive', () => {
  for (const [text, shape] of SHAPE_TABLE) {
    assert.equal(classifyTurnShape(text), classifyTurnShape(text), 'same input, same answer');
    assert.equal(classifyTurnShape(`  ${text.toUpperCase()}  `), shape, `"${text}" upper-cased and padded`);
    assert.ok((TURN_SHAPES as readonly string[]).includes(classifyTurnShape(text)), 'a member of TURN_SHAPES');
  }
});

// ── the rendered block ───────────────────────────────────────────────────────

const HITS: TurnFocusInput['hits'] = [
  { label: 'speed vs craft', source: 'thread' },
  { label: 'cedar lead times', source: 'research' },
];

test('renderTurnFocus restates the message, names the shape, and closes on the answer-THIS line', () => {
  const block = renderTurnFocus({ text: 'so are they coming or not', hits: [] });
  assert.ok(block.startsWith("## This turn — what you're answering\n"), 'the header leads');
  assert.ok(block.includes(`<their_message>\nso are they coming or not\n</their_message>`), 'their words, data-tagged');
  assert.ok(block.includes('\nShape: question\n'), 'the classified shape');
  assert.ok(
    block.endsWith('Answer THIS. Everything above is background — it may shape HOW you answer, never WHAT.'),
    'and the counterweight is the last thing in it',
  );
});

test('renderTurnFocus lists the hits it was handed, source-labelled, at most two', () => {
  const two = renderTurnFocus({ text: 'any word on the cedars', hits: HITS });
  assert.ok(two.includes('What you hold that touches it: speed vs craft (thread) · cedar lead times (research)'));

  const three = renderTurnFocus({
    text: 'any word on the cedars',
    hits: [...HITS, { label: 'they run a nursery', source: 'fact' }],
  });
  assert.equal(TURN_FOCUS_MAX_HITS, 2);
  assert.ok(!three.includes('they run a nursery'), 'the third hit is not rendered');
  assert.equal((three.match(/ · /g) ?? []).length, TURN_FOCUS_MAX_HITS - 1, 'exactly two hits, one separator');
});

test('renderedTurnFocusHits IS what the block prints — the receipt reads it, not the raw list', () => {
  // The turn receipt (convo/client.ts) reports "what she was shown". It used to slice the raw hits,
  // but the block drops a blank name BEFORE it counts to two — so a nameless hit at the front made
  // the receipt claim a label the block had thrown away, and hide the one it printed in its place.
  const hits: TurnFocusHit[] = [
    { label: '   ', source: 'research' },              // no name → not evidence, never printed
    { label: 'speed vs craft', source: 'thread' },
    { label: 'cedar lead\n  times', source: 'research' },
    { label: 'they run a nursery', source: 'fact' },   // past the cap
  ];
  assert.deepEqual(
    renderedTurnFocusHits(hits),
    [{ label: 'speed vs craft', source: 'thread' }, { label: 'cedar lead times', source: 'research' }],
    'blank dropped first, then flattened, then capped',
  );

  const block = renderTurnFocus({ text: 'any word on the cedars', hits });
  for (const h of renderedTurnFocusHits(hits)) assert.ok(block.includes(`${h.label} (${h.source})`), h.label);
  assert.ok(!block.includes('they run a nursery'), 'and nothing it did not print');

  // A hit whose name is only whitespace leaves nothing behind at all.
  assert.deepEqual(renderedTurnFocusHits([{ label: ' \n ', source: 'note' }]), []);
});

test('renderTurnFocus says so plainly when nothing it holds touches the turn', () => {
  const block = renderTurnFocus({ text: 'ugh long day', hits: [] });
  assert.ok(block.includes('nothing here touches it; answer from the thread above.'));
  assert.ok(!block.includes(' · '), 'no hit list');
});

test('renderTurnFocus caps the restated message at TURN_FOCUS_TEXT_CHARS', () => {
  const long = `the cedars ${'and more about them '.repeat(60)}`.trim();
  assert.ok(long.length > TURN_FOCUS_TEXT_CHARS, 'the fixture is genuinely over the cap');
  const block = renderTurnFocus({ text: long, hits: [] });
  const payload = block.slice(
    block.indexOf('<their_message>\n') + '<their_message>\n'.length,
    block.indexOf('\n</their_message>'),
  );
  assert.ok(payload.length <= TURN_FOCUS_TEXT_CHARS, `payload is ${payload.length}, cap is ${TURN_FOCUS_TEXT_CHARS}`);
  assert.ok(payload.startsWith('the cedars '), 'it is the head of what they said');
  assert.ok(payload.endsWith('…'), 'and it is marked as clipped');
});

test('renderTurnFocus caps a hit label and keeps it on one line', () => {
  const block = renderTurnFocus({
    text: 'any word on the cedars',
    hits: [{ label: `cedar ${'x'.repeat(400)}\nsecond line`, source: 'research' }],
  });
  const hitLine = block.split('\n').find(l => l.startsWith('What you hold that touches it: '))!;
  assert.ok(hitLine, 'the hit line is one line');
  assert.ok(hitLine.length <= 'What you hold that touches it: '.length + TURN_FOCUS_LABEL_CHARS + ' (research)'.length);
  assert.ok(hitLine.endsWith(' (research)'), 'the source still lands');
});

test('renderTurnFocus renders nothing when there is nothing to restate', () => {
  assert.equal(renderTurnFocus({ text: '', hits: HITS }), '');
  assert.equal(renderTurnFocus({ text: '   \n ', hits: [] }), '');
});

test('renderTurnFocus is pure — it never mutates what it was handed', () => {
  const input: TurnFocusInput = { text: 'any word on the cedars', hits: [...HITS] };
  const before = JSON.stringify(input);
  renderTurnFocus(input);
  assert.equal(JSON.stringify(input), before);
});

// ── placement: last inside </prompt>, on every path ──────────────────────────

const PROFILE: UserProfile = {
  handle: '+15550001111', name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2,
};

const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: '+15550001111', at: Date.UTC(2026, 0, 6, 1, 40) },
  { role: 'assistant', content: 'checking now', at: Date.UTC(2026, 0, 6, 1, 42) },
];

const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft', note: 'they keep landing back on shipping fast versus doing it right',
};

const FOCUS: TurnFocusInput = { text: 'so are they coming or not', hits: HITS };

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** Four assembled turns whose LAST dyn section differs today — the reply-order read, the burst
 *  manifest, a tapped reply (which suppresses the order read), and the caller's own addendum, which
 *  was the last push site before this block existed. */
const PLACEMENT: Array<{ name: string; args: BuildArgs }> = [
  {
    name: 'plain 1:1 (reply-order read last today)',
    args: [
      { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111', senderProfile: PROFILE },
      '## Who you are talking to\nSam, three months in.', [], undefined, undefined, HISTORY,
      'so are they coming or not', 'UTC', undefined, undefined, null, undefined,
      { offer: THEME, outcomeAsk: null }, null, FOCUS,
    ],
  },
  {
    name: 'burst (burst manifest)',
    args: [
      {
        isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111',
        senderProfile: PROFILE,
        burstManifest: [{ text: 'hey' }, { text: 'did the cedars land' }],
      },
      '', [], undefined, undefined, [], 'did the cedars land', 'UTC',
      undefined, undefined, null, undefined, undefined, null, FOCUS,
    ],
  },
  {
    name: 'tapped reply (order read suppressed)',
    args: [
      {
        isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111',
        senderProfile: PROFILE, repliedTo: { kind: 'assistant', text: 'the cedars ship thursday' },
      },
      '', [], undefined, undefined, HISTORY, 'wait which thursday', 'UTC',
      undefined, undefined, null, undefined, undefined, null, FOCUS,
    ],
  },
  {
    name: 'caller addendum (the previous last push site)',
    args: [
      undefined, '', [], '## One more thing\nAn addendum the caller tacked on.', undefined, HISTORY,
      'so are they coming or not', 'UTC', undefined, undefined, null, undefined, undefined, null, FOCUS,
    ],
  },
];

test('turn_focus is the LAST dyn section id, so a new push site cannot land after it', () => {
  assert.equal(DYN_SECTION_IDS[DYN_SECTION_IDS.length - 1], 'turn_focus');
});

test('the turn-focus block is the last section inside </prompt>, on every path', () => {
  for (const p of PLACEMENT) {
    const { system, sections } = buildSystemPromptSections(...p.args);
    const names = sections.map(s => s.name);

    // (1) by section order: the last dyn section, i.e. the one right before the anchors.
    assert.deepEqual(names.slice(-3), ['turn_focus', 'behavior_anchor', 'json_anchor'], p.name);

    // (2) by string position: nothing of the block's own between it and the closing tag.
    const block = renderTurnFocus(FOCUS);
    const at = system.indexOf(block);
    assert.ok(at > 0, `${p.name}: the block is in the prompt`);
    // lastIndexOf, not indexOf: the persona's own "What <prompt> is" section names the closing tag
    // in prose long before the real one, and nothing after the block carries it.
    const close = system.lastIndexOf(`</${PROMPT_TAG}>`);
    assert.ok(at < close, `${p.name}: inside the block`);
    assert.equal(system.slice(at + block.length, close), '\n', `${p.name}: nothing between it and </prompt>`);
  }
});

test('the extra section still renders — the focus block sits after it, not instead of it', () => {
  const { system } = buildSystemPromptSections(...PLACEMENT[3].args);
  assert.ok(system.includes('An addendum the caller tacked on.'));
  assert.ok(system.indexOf('An addendum the caller tacked on.') < system.indexOf("## This turn — what you're answering"));
});

// ── the flag ─────────────────────────────────────────────────────────────────

test('CONVO_TURN_FOCUS_BLOCK defaults ON and parses like its siblings', () => {
  const saved = process.env.CONVO_TURN_FOCUS_BLOCK;
  try {
    delete process.env.CONVO_TURN_FOCUS_BLOCK;
    assert.equal(turnFocusBlockEnabled(), true, 'unset is on');
    for (const v of ['', 'true', '1', 'on', 'yes', 'YES']) {
      process.env.CONVO_TURN_FOCUS_BLOCK = v;
      assert.equal(turnFocusBlockEnabled(), true, `"${v}" is on`);
    }
    for (const v of ['false', '0', 'off', 'no', 'nonsense']) {
      process.env.CONVO_TURN_FOCUS_BLOCK = v;
      assert.equal(turnFocusBlockEnabled(), false, `"${v}" is off`);
    }
  } finally {
    if (saved === undefined) delete process.env.CONVO_TURN_FOCUS_BLOCK;
    else process.env.CONVO_TURN_FOCUS_BLOCK = saved;
  }
});

test('flag off → the section is not pushed and the prompt is byte-identical to no block at all', () => {
  const saved = process.env.CONVO_TURN_FOCUS_BLOCK;
  try {
    for (const p of PLACEMENT) {
      const withoutInput = buildSystemPromptSections(...p.args.slice(0, 14) as BuildArgs);
      process.env.CONVO_TURN_FOCUS_BLOCK = 'false';
      const flaggedOff = buildSystemPromptSections(...p.args);
      assert.equal(flaggedOff.system, withoutInput.system, `${p.name}: byte-identical with the flag off`);
      assert.deepEqual(flaggedOff.sections, withoutInput.sections, `${p.name}: and no section reported`);
      assert.ok(!flaggedOff.sections.some(s => s.name === 'turn_focus'));

      process.env.CONVO_TURN_FOCUS_BLOCK = 'true';
      assert.ok(buildSystemPromptSections(...p.args).sections.some(s => s.name === 'turn_focus'), `${p.name}: back on`);
    }
  } finally {
    if (saved === undefined) delete process.env.CONVO_TURN_FOCUS_BLOCK;
    else process.env.CONVO_TURN_FOCUS_BLOCK = saved;
  }
});

test('no turn-focus input → no section, whatever the flag says (the composer/second-pass path)', () => {
  const args = PLACEMENT[0].args.slice(0, 14) as BuildArgs;
  const { system, sections } = buildSystemPromptSections(...args);
  assert.ok(!sections.some(s => s.name === 'turn_focus'));
  assert.ok(!system.includes("## This turn — what you're answering"));
  assert.equal(buildSystemPrompt(...args), system, 'and the string wrapper still agrees');
});
