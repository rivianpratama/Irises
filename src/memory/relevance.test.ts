// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
//
// The turn relevance router: one pure verdict per turn that every memory gate and the turn-focus
// block read. What these pin is the three properties the rest of P2 builds on — the router is PURE
// (no clock, no DB), a turn with nothing to compare fails OPEN as a gate but produces NO evidence,
// and a hit only exists where a real salient token is shared.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnRelevance, threadHit, memoryRelevanceEnabled, shortEntryLabel, shortEntryAsk,
  RELEVANCE_HIT_KINDS, RELEVANCE_HITS_MAX,
} from './relevance.js';
import {
  renderShortBlockWithHot, renderUserMemory, renderUserMemoryWithHot, splitSections,
  type UserMemoryData,
} from './wrappers.js';
import { buildContextBlockWithHot } from './dossier.js';
import { renderTurnFocus, TURN_FOCUS_HIT_SOURCES, TURN_FOCUS_LABEL_CHARS } from '../agents/convo/turnFocus.js';
import { addShortTerm, type ShortTermEntry } from '../db/repositories/memoryShort.js';
import { addImportantNote } from '../db/repositories/memoryMedium.js';
import type { MediumBundle } from './mediumTerm.js';

const NOW = Date.parse('2026-07-14T12:00:00Z');
let handleSeq = 0;

function shortEntry(over: Partial<ShortTermEntry> = {}): ShortTermEntry {
  return {
    id: over.id ?? 's1', agentHandle: '+15550005555', kind: over.kind ?? 'ops_research',
    request: over.request, content: over.content ?? 'result', meta: over.meta ?? {},
    taskId: over.taskId, createdAt: over.createdAt ?? NOW - 60_000,
    expiresAt: over.expiresAt ?? NOW + 60 * 60 * 1000, chatId: over.chatId,
  };
}

function medium(over: Partial<MediumBundle> = {}): MediumBundle {
  return { directives: over.directives ?? [], notes: over.notes ?? [], facts: over.facts ?? {} };
}

// ── tokens and shape ─────────────────────────────────────────────────────────

test('the router carries the turn as tokens and as a shape', () => {
  const turn = buildTurnRelevance('any word on the cedar lead times?', {});
  assert.deepEqual([...turn.tokens].sort(), ['cedar', 'lead', 'times', 'word']);
  assert.equal(turn.shape, 'question');

  assert.equal(buildTurnRelevance('hey', {}).shape, 'greeting');
  assert.equal(buildTurnRelevance('look up flights to tokyo', {}).shape, 'work_ask');
  assert.equal(buildTurnRelevance(undefined, {}).shape, 'statement');
  assert.equal(buildTurnRelevance('  ', {}).tokens.size, 0);
});

test('touches is touchesTurn over the same turn text, in both empty modes', () => {
  const turn = buildTurnRelevance('any word on cedar yet', {});
  assert.equal(turn.touches('cedar lead times', 'touch'), true);
  assert.equal(turn.touches('dinner plans', 'touch'), false, 'a token-bearing turn against an unrelated candidate is a real no-match');
  assert.equal(turn.touches('dinner plans', 'no_touch'), false);
});

// ── the media-only turn: every gate fails OPEN, and nothing is evidence ──────
// The verified sequencing (convo/client.ts) builds the router from `userMessage`, which is EMPTY on
// a caption-less media turn — the attachment note is spliced in later. So the router has nothing to
// compare, and the two answers pull opposite ways on purpose: as a GATE it must never lose a held
// entry over a turn it could not read, and as EVIDENCE it must never name a held thing it cannot
// show touches anything.

test('a media-only turn fails every gate open and produces no hits', () => {
  const held = {
    short: [shortEntry({ request: 'cedar lead times' })],
    medium: medium({ notes: ['the shack rewiring is booked for august'] }),
    longSections: ['## Their world\nfixing up a lake cabin'],
  };
  const turn = buildTurnRelevance('', held);
  assert.equal(turn.tokens.size, 0);
  assert.equal(turn.touches('cedar lead times', 'touch'), true, 'fails OPEN');
  assert.equal(turn.touches('anything at all', 'touch'), true);
  assert.equal(turn.touches('cedar lead times', 'no_touch'), false, 'and CLOSED where the caller wants that');
  assert.deepEqual(turn.hits, [], 'nothing touched it, so nothing is evidence');

  // Same for an absent turn and for a turn whose every token is a stopword.
  assert.equal(buildTurnRelevance(undefined, held).touches('cedar', 'touch'), true);
  assert.deepEqual(buildTurnRelevance(undefined, held).hits, []);
  assert.equal(buildTurnRelevance('ok thanks', held).touches('cedar', 'touch'), true);
  assert.deepEqual(buildTurnRelevance('ok thanks', held).hits, []);
});

// ── hits, one per held channel ───────────────────────────────────────────────

test('hits come off every held channel, named the way a person would name it', () => {
  const turn = buildTurnRelevance('cedar for the shack, and the electrician invoice — lowercase please', {
    short: [
      shortEntry({ id: 'r1', request: 'cedar lead times from the north supplier' }),
      shortEntry({ id: 'e1', kind: 'email_flag', request: 'electrician invoice', content: 'unrelated body', meta: { from: 'mike@x.com', subject: 'electrician invoice' } }),
    ],
    medium: medium({
      notes: ['the shack rewiring is booked for august'],
      facts: { comms_style: 'lowercase, no exclamation marks' },
      directives: [{ id: 'd1', text: 'always reply in lowercase', createdAt: NOW }],
    }),
    longSections: ['## Their world\nfixing up a lake cabin — calls it the shack'],
  });

  const byKind = new Map(turn.hits.map(h => [h.kind, h]));
  assert.deepEqual([...byKind.keys()].sort(), ['directive', 'email', 'fact', 'long', 'note', 'research']);
  assert.equal(byKind.get('research')!.label, 'cedar lead times from the north supplier');
  assert.equal(byKind.get('research')!.source, 'r1');
  assert.equal(byKind.get('email')!.label, 'electrician invoice');
  assert.equal(byKind.get('note')!.label, 'the shack rewiring is booked for august');
  assert.equal(byKind.get('note')!.source, 'note:0');
  assert.equal(byKind.get('fact')!.label, 'comms style: lowercase, no exclamation marks');
  assert.equal(byKind.get('fact')!.source, 'comms_style');
  assert.equal(byKind.get('directive')!.label, 'always reply in lowercase');
  assert.equal(byKind.get('directive')!.source, 'd1');
  assert.equal(byKind.get('long')!.label, 'Their world', 'a long section is named by its heading');
  for (const h of turn.hits) assert.ok(h.score >= 1, `${h.kind} scored ${h.score}`);
});

test("a look is matched by its ASK, never by the result body it already delivered", () => {
  const turn = buildTurnRelevance('what about bitcoin', {
    short: [shortEntry({ request: 'weather in tokyo', content: 'bitcoin is at 91k' })],
  });
  assert.deepEqual(turn.hits, [], 'the body mentions bitcoin; the ask does not');
});

test('hits rank by shared-token count, and are capped for the 30-day receipt', () => {
  const turn = buildTurnRelevance('cedar lead times for the shack', {
    medium: medium({
      notes: [
        'the shack',                          // 1 shared token
        'cedar lead times for the shack roof', // 4 shared tokens
        'cedar for the porch',                 // 1 shared token, longer than "the shack"
      ],
    }),
  });
  assert.equal(turn.hits[0].label, 'cedar lead times for the shack roof');
  assert.equal(turn.hits[0].score, 4);
  assert.deepEqual(turn.hits.map(h => h.score), [4, 1, 1]);
  // The one-token pair is broken by overlap, not by array order: "the shack" IS the turn's phrase
  // more completely than "cedar for the porch" is.
  assert.equal(turn.hits[1].label, 'the shack');

  const many = buildTurnRelevance('cedar', {
    medium: medium({ notes: Array.from({ length: 20 }, (_, i) => `cedar note ${i}`) }),
  });
  assert.equal(many.hits.length, RELEVANCE_HITS_MAX);
});

test('a 40-note bundle yields hits only for the notes that touch the turn', () => {
  const notes = Array.from({ length: 40 }, (_, i) => `durable note number ${i} about groceries and laundry`);
  notes[7] = 'the shack rewiring is booked for august';
  notes[31] = 'cedar comes from the north supplier';
  const turn = buildTurnRelevance('any word on cedar for the shack?', { medium: medium({ notes }) });
  assert.deepEqual(turn.hits.map(h => h.source).sort(), ['note:31', 'note:7']);
});

test('a hit with no name is not evidence', () => {
  const turn = buildTurnRelevance('cedar', {
    short: [shortEntry({ request: undefined, meta: {} })],
    medium: medium({ notes: ['   '], directives: [{ id: 'd', text: '  ', createdAt: NOW }], facts: { cedar_slot: '' } }),
  });
  assert.deepEqual(turn.hits, []);
});

// ── the standing thread, which arrives through its own door ─────────────────

test('threadHit scores the offer against the same tokens and is never score-gated', () => {
  const turn = buildTurnRelevance('any word on cedar yet', {});
  assert.deepEqual(threadHit(turn, 'cedar lead times'), { kind: 'thread', label: 'cedar lead times', score: 1, source: 'cedar lead times' });
  // A LOOP is offered precisely when it is NOT the current topic (persona/threads.ts inverts the
  // check there on purpose), so an off-topic offer still has to be shown as what she was handed.
  assert.equal(threadHit(turn, 'how did the interview go').score, 0);
  assert.equal(threadHit(null, 'speed vs craft').score, 0);
  assert.equal(threadHit(turn, '  speed   vs craft ').label, 'speed vs craft');
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the router is pure: same answer twice, and nothing it was handed is mutated', () => {
  const held = {
    short: [shortEntry({ request: 'cedar lead times' })],
    medium: medium({ notes: ['cedar for the shack'], facts: { comms_style: 'lowercase' }, directives: [{ id: 'd1', text: 'cedar only', createdAt: NOW }] }),
    longSections: ['## Their world\ncedar cabin'],
  };
  const snapshot = JSON.stringify(held);
  const a = buildTurnRelevance('cedar?', held);
  const b = buildTurnRelevance('cedar?', held);
  assert.deepEqual(a.hits, b.hits);
  assert.deepEqual([...a.tokens], [...b.tokens]);
  assert.equal(JSON.stringify(held), snapshot, 'inputs untouched');
  assert.deepEqual(buildTurnRelevance('cedar?', {}).hits, [], 'no held items, no hits');
});

test('a label is one line, and short enough for a 30-day receipt', () => {
  const long = `cedar ${'x'.repeat(400)}\nsecond line`;
  const turn = buildTurnRelevance('cedar', { medium: medium({ notes: [long] }) });
  assert.equal(turn.hits[0].label.length, TURN_FOCUS_LABEL_CHARS, 'clipped to what the block renders');
  assert.ok(turn.hits[0].label.endsWith('…'));
  assert.ok(!turn.hits[0].label.includes('\n'), 'flattened to one line');
  // The same clip the renderer would apply, so the receipt says exactly what the model was shown —
  // and a 40-note bundle can never put 40 note bodies into diagnostic_turn_history.
  assert.equal(renderTurnFocus({ text: 'cedar', hits: [{ label: turn.hits[0].label, source: 'note' }] }).includes(turn.hits[0].label), true);
});

test('every relevance kind is something the turn-focus block can render', () => {
  // Two vocabularies, one meaning: the router names the channel, the block prints it. They have to
  // stay in step or a hit would render as a source the type never named.
  for (const kind of RELEVANCE_HIT_KINDS) {
    assert.ok((TURN_FOCUS_HIT_SOURCES as readonly string[]).includes(kind), kind);
  }
});

test('every hit kind is a member of the single-sourced vocabulary', () => {
  const turn = buildTurnRelevance('cedar shack electrician lowercase cabin', {
    short: [
      shortEntry({ id: 'r1', request: 'cedar lead times' }),
      shortEntry({ id: 'e1', kind: 'email_flag', request: 'electrician quote', meta: { subject: 'electrician quote' } }),
    ],
    medium: medium({ notes: ['the shack'], facts: { comms_style: 'lowercase' }, directives: [{ id: 'd1', text: 'lowercase always', createdAt: NOW }] }),
    longSections: ['## Cabin\nthe shack'],
  });
  assert.ok(turn.hits.length > 0);
  for (const h of turn.hits) assert.ok((RELEVANCE_HIT_KINDS as readonly string[]).includes(h.kind), h.kind);
  assert.ok((RELEVANCE_HIT_KINDS as readonly string[]).includes(threadHit(turn, 'x').kind));
});

// ── the short-tier naming helpers ────────────────────────────────────────────

test('shortEntryLabel names a look the way the user asked for it; shortEntryAsk is what it matches by', () => {
  assert.equal(shortEntryLabel(shortEntry({ request: 'bitcoin price today', meta: { topicKey: 'general:btc' } })), 'bitcoin price today');
  assert.equal(shortEntryLabel(shortEntry({ request: undefined, meta: { topicKey: 'general:btc' } })), 'general:btc');
  assert.equal(shortEntryLabel(shortEntry({ request: undefined, meta: {} })), '');
  assert.equal(shortEntryLabel(shortEntry({ request: '  ', meta: { topicKey: 42 } })), '', 'a non-string topicKey is not a label');
  assert.equal(shortEntryAsk(shortEntry({ request: 'bitcoin price', meta: { topicKey: 'general:btc' } })), 'bitcoin price general:btc');
  assert.equal(shortEntryAsk(shortEntry({ request: undefined, meta: {} })), ' ', 'nothing to match by');
});

// ── the seam: the memory stack reads the router ──────────────────────────────
// The short tier's hot-look gate was the original of this logic, so handing it the router has to be
// a no-op on the bytes: same verdict, same block, on-topic and moved-on alike. That equivalence is
// what makes the widening safe to land ahead of the gates that will actually use it (Task 11).

test('the short-tier hot-look gate lands on the same verdict through the router', () => {
  const hot = shortEntry({ id: 'hot', request: 'bitcoin price today', content: 'x'.repeat(300), createdAt: NOW - 60_000 });
  const older = shortEntry({ id: 'old', request: 'weather in tokyo', content: 'y'.repeat(300), createdAt: NOW - 90 * 60_000 });
  const entries = [hot, older];
  for (const text of ['what about bitcoin now', 'help me plan dinner tonight', 'ok thanks', '']) {
    const plain = renderShortBlockWithHot(entries, NOW, null, text);
    const routed = renderShortBlockWithHot(entries, NOW, null, text, buildTurnRelevance(text, { short: entries }));
    assert.equal(routed.text, plain.text, `same bytes: "${text}"`);
    assert.equal(routed.hotEntry?.id ?? null, plain.hotEntry?.id ?? null, `same verdict: "${text}"`);
  }
});

test('the memory stack renders the same bytes with a router as without', () => {
  const data: UserMemoryData = {
    profile: { handle: '+15550005555', name: 'Jordan', facts: ['fixing up a lake cabin'], firstSeen: 0, lastSeen: 0 },
    memory: null,
    medium: medium({ notes: ['the shack rewiring is booked for august'], facts: { comms_style: 'lowercase' }, directives: [{ id: 'd1', text: 'always reply in lowercase', createdAt: NOW }] }),
    short: [shortEntry({ request: 'cedar lead times', content: 'z'.repeat(300) })],
    longDocMd: '## Who they are\nJordan, print shop owner\n\n## Their world\nthe shack',
  };
  for (const text of ['any word on cedar yet', 'what should i cook for dinner']) {
    const opts = { audience: 'individual' as const, currentTurnText: text };
    const plain = renderUserMemory('convo', data, NOW, opts);
    const routed = renderUserMemoryWithHot('convo', data, NOW, { ...opts, turn: buildTurnRelevance(text, { short: data.short, medium: data.medium, longSections: splitSections(data.longDocMd) }) });
    assert.equal(routed.text, plain, `same bytes: "${text}"`);
  }
});

test('buildContextBlockWithHot builds the router when the flag is on, and the block is byte-identical either way', async () => {
  const h = `+1555410${(handleSeq++).toString().padStart(4, '0')}`;
  await addShortTerm({ agentHandle: h, kind: 'ops_research', request: 'cedar lead times', content: 'x'.repeat(300) });
  await addImportantNote(h, 'the shack rewiring is booked for august');

  const prior = process.env.CONVO_MEMORY_RELEVANCE;
  try {
    for (const text of ['any word on cedar for the shack yet', 'what should i cook for dinner']) {
      delete process.env.CONVO_MEMORY_RELEVANCE;
      const on = await buildContextBlockWithHot(h, text);
      process.env.CONVO_MEMORY_RELEVANCE = 'false';
      const off = await buildContextBlockWithHot(h, text);

      assert.equal(on.block, off.block, `byte-identical block: "${text}"`);
      assert.equal(on.hotLook?.request ?? null, off.hotLook?.request ?? null, `same hot look: "${text}"`);
      assert.equal(off.turn, null, 'flag off → no router is built');
      assert.ok(on.turn, 'flag on → the router rode along');
      assert.ok(on.turn!.tokens.size > 0, 'carrying this turn\'s own tokens');
    }
    // …and with the flag on, the held things that touch the turn are named off the real stores.
    delete process.env.CONVO_MEMORY_RELEVANCE;
    const named = await buildContextBlockWithHot(h, 'any word on cedar for the shack yet');
    assert.deepEqual(
      named.turn!.hits.map(hit => hit.kind).sort(),
      ['note', 'research'],
      'a look and a note, straight off the loaders',
    );
    assert.deepEqual(await buildContextBlockWithHot(h, 'what should i cook for dinner').then(r => r.turn!.hits), []);
  } finally {
    if (prior === undefined) delete process.env.CONVO_MEMORY_RELEVANCE;
    else process.env.CONVO_MEMORY_RELEVANCE = prior;
  }
});

// ── the flag ─────────────────────────────────────────────────────────────────

test('CONVO_MEMORY_RELEVANCE parses like its sibling flags, default ON', () => {
  const prior = process.env.CONVO_MEMORY_RELEVANCE;
  try {
    delete process.env.CONVO_MEMORY_RELEVANCE;
    assert.equal(memoryRelevanceEnabled(), true, 'unset → ON');
    for (const on of ['true', '1', 'on', 'yes', 'YES', ' On ']) {
      process.env.CONVO_MEMORY_RELEVANCE = on;
      assert.equal(memoryRelevanceEnabled(), true, on);
    }
    for (const off of ['false', '0', 'off', 'no', 'nope']) {
      process.env.CONVO_MEMORY_RELEVANCE = off;
      assert.equal(memoryRelevanceEnabled(), false, off);
    }
  } finally {
    if (prior === undefined) delete process.env.CONVO_MEMORY_RELEVANCE;
    else process.env.CONVO_MEMORY_RELEVANCE = prior;
  }
});
