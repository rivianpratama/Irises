// Run with: npm test   (TZ=UTC, DATA_BACKEND=memory)
//
// The Inner-state panel's four SHAPERS, and nothing else. The route around them is a read of four
// repositories behind the dashboard's own auth + cache, and the client half is a browser string the
// existing views.test.ts already scans — what is worth pinning here is the arithmetic that turns
// stored rows into what an operator reads:
//
//   • the affect trail, whose points carry no `mood_shift` of their own (persona/status.ts MoodPoint
//     doesn't store one) — so only the newest point can name a shift, off the `last` status, and
//     this is where that stays honest;
//   • the climate dials, which mean nothing without their own floor/ceiling and what the rolling
//     week has already spent;
//   • the thread inventory, summarized without leaking a note's text;
//   • the last N `turn:trace` receipts, flattened out of the persisted turn payloads.
//
// Every one of them is pure and takes its clock injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { affectTrail, climateDialRows, threadSummary, traceRows } from './affect.js';
import { MOOD_HISTORY_CAP, type AffectState, type AffectStatus } from '../../../persona/status.js';
import { CLIMATE_WINDOW_CAP, type RelationshipClimate } from '../../../persona/climate.js';
import { defaultThreadInventory, type ThreadInventory } from '../../../persona/threads.js';
import { TURN_TRACE_LABEL } from '../../traceLabels.js';
import type { Turn } from '../../turns.js';
import type { TraceEvent } from '../../trace.js';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MIN = 60_000;

function status(over: Partial<AffectStatus> = {}): AffectStatus {
  return {
    mood_label: 'hopeful', mood_core: 'powerful', mood_level: 72, mood_shift: 'lifted',
    intent_mode: 'chatting', terminal_closure: false, epistemic_trigger: 'none',
    meta_prompt: 'keep it light and follow their lead',
    warmth: 80, patience: 75, social_battery: 65, anxiety: 30, rapport: 55,
    at: NOW - MIN,
    ...over,
  } as AffectStatus;
}

function stateWithTrail(points: number): AffectState {
  const last = status();
  return {
    last,
    moodHistory: Array.from({ length: points }, (_, i) => ({
      level: 50 + i, core: 'peaceful' as const, label: `p${i}`, at: NOW - (points - i) * MIN,
      anxiety: 30 + i, warmth: 70 + i, social_battery: 60 + i, rapport: 50 + i,
    })),
  };
}

// ── the affect trail ─────────────────────────────────────────────────────────

test('the trail runs newest-first and only its newest point can name a mood shift', () => {
  const state = stateWithTrail(3);
  // The newest stored point IS the last status here (same clock), which is the live shape:
  // saveAffectState pushes `last` onto the trail in the same write.
  state.moodHistory[2].at = state.last!.at;
  const rows = affectTrail(state);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'p2', 'newest first — an operator reads down from now');
  assert.equal(rows[0].shift, 'lifted', 'the newest point takes the shift off the last status');
  assert.equal(rows[1].shift, null, 'an older point has none stored, so it claims none');
  assert.deepEqual(
    { level: rows[1].level, core: rows[1].core, warmth: rows[1].warmth, anxiety: rows[1].anxiety },
    { level: 51, core: 'peaceful', warmth: 71, anxiety: 31 },
  );
});

test('the trail is bounded by the stored cap and survives an empty/garbled state', () => {
  const rows = affectTrail(stateWithTrail(MOOD_HISTORY_CAP + 4));
  assert.equal(rows.length, MOOD_HISTORY_CAP, 'never more than the store itself keeps');
  assert.deepEqual(affectTrail({ moodHistory: [] }), [], 'a chat with no affect row reads as empty');
  // A point written before the gauges existed: no numbers, and nothing invented for it.
  const bare = affectTrail({ moodHistory: [{ level: 40, core: 'sad', label: 'flat', at: NOW }] });
  assert.deepEqual(
    { warmth: bare[0].warmth, rapport: bare[0].rapport, shift: bare[0].shift },
    { warmth: null, rapport: null, shift: null },
  );
});

// ── the climate dials ────────────────────────────────────────────────────────

test('each dial reports its own bounds and what the rolling week has spent', () => {
  const climate: RelationshipClimate = {
    dials: { ease: 42, candor: 45, playfulness: 25 },
    moves: [
      { at: NOW - 2 * 86_400_000, k: 'ease', d: 2 },
      { at: NOW - 86_400_000, k: 'ease', d: -1 },
      { at: NOW - 30 * 86_400_000, k: 'candor', d: 4 },  // outside the window
    ],
    lastEvalAt: NOW - 3 * 3_600_000,
    evalCount: 9,
  };
  const rows = climateDialRows(climate, NOW);
  assert.deepEqual(rows.map(r => r.key), ['ease', 'candor', 'playfulness'], 'the table order');
  const ease = rows[0];
  assert.deepEqual(
    { value: ease.value, dflt: ease.dflt, floor: ease.floor, ceiling: ease.ceiling, spent: ease.spent, cap: ease.cap },
    { value: 42, dflt: 35, floor: 20, ceiling: 80, spent: 3, cap: CLIMATE_WINDOW_CAP },
  );
  assert.equal(rows[1].spent, 0, 'a move older than the window is not still being billed');
  assert.equal(rows[2].moved, false, 'a dial still at its default says so');
  assert.equal(ease.moved, true);
});

// ── the thread inventory ─────────────────────────────────────────────────────

test('the thread summary counts by status and carries no note text', () => {
  const inv: ThreadInventory = {
    ...defaultThreadInventory(),
    themes: [
      { id: 't1', label: 'the cedar cabin', kind: 'goal', note: 'SECRET NOTE', evidenceDays: [1, 2], evidenceCount: 2, status: 'taggable', confidence: 70, firstSeenAt: NOW - 9 * 86_400_000, lastSeenAt: NOW - 86_400_000, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0 },
      { id: 't2', label: 'toast nerves', kind: 'tension', note: 'ALSO SECRET', evidenceDays: [1], evidenceCount: 1, status: 'open', confidence: 30, firstSeenAt: NOW - 2 * 86_400_000, lastSeenAt: NOW - 2 * 86_400_000, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0 },
    ],
    loops: [
      { id: 'l1', label: 'the electrician', note: 'LOOP NOTE', status: 'open', capturedAt: NOW - 4 * 86_400_000, lastSeenAt: NOW - 4 * 86_400_000, offeredAt: 0, askedAt: 0, resolvedAt: 0, passes: 0 },
      { id: 'l2', label: 'the dentist', note: 'x', status: 'resolved', capturedAt: NOW - 8 * 86_400_000, lastSeenAt: NOW - 8 * 86_400_000, offeredAt: 0, askedAt: 0, resolvedAt: NOW - 86_400_000, passes: 0 },
    ],
    turnsSinceOffer: 4,
    harvestCount: 31,
    lastHarvestAt: NOW - MIN,
  };
  const s = threadSummary(inv);
  // Counted by the status each row actually carries — a sparse map, so a status added to
  // persona/threads.ts shows up here without this file holding a second copy of that union.
  assert.deepEqual(s.themes, { total: 2, byStatus: { taggable: 1, open: 1 } });
  assert.deepEqual(s.loops, { total: 2, byStatus: { open: 1, resolved: 1 } });
  assert.deepEqual({ turnsSinceOffer: s.turnsSinceOffer, harvestCount: s.harvestCount }, { turnsSinceOffer: 4, harvestCount: 31 });
  assert.deepEqual(s.labels.map(l => l.label), ['the cedar cabin', 'toast nerves', 'the electrician', 'the dentist']);
  const json = JSON.stringify(s);
  for (const secret of ['SECRET NOTE', 'ALSO SECRET', 'LOOP NOTE']) {
    assert.ok(!json.includes(secret), `the summary leaked a stored note: ${secret}`);
  }
});

test('an empty inventory summarizes to zeros rather than to nothing', () => {
  const s = threadSummary(defaultThreadInventory());
  assert.deepEqual(s.themes, { total: 0, byStatus: {} });
  assert.deepEqual(s.loops, { total: 0, byStatus: {} });
  assert.deepEqual(s.labels, []);
  assert.equal(s.turnsSinceOffer, 0);
});

// ── the turn:trace rows ──────────────────────────────────────────────────────

function traceEvent(at: number, over: Record<string, unknown> = {}): TraceEvent {
  return {
    id: 1, ts: at, type: 'event', label: TURN_TRACE_LABEL,
    detail: {
      prompt: {
        sections: [{ name: 'persona', chars: 90_000 }, { name: 'turn_focus', chars: 400 }],
        personaChars: 90_000, dynChars: 12_000, anchorChars: 700,
        systemChars: 102_700, messagesChars: 800, transcriptRows: 12,
        transcriptShare: 0.0077, cacheBreakpoints: 2, craft: [],
      },
      gates: {
        threads: { reason: 'offered_theme' },
        memory: { shortHotLook: 'none', hits: [{ kind: 'note', label: 'dana' }], blocks: { notes: { verdict: 'digest', reason: 'partly_kept', dropped: 3 } } },
        extras: { updateNote: false, introWeave: false, activeOps: 0 },
      },
      affect: {
        source: 'emitted', rawEmitted: { mood_label: 'hopeful' },
        coerced: { mood_label: 'hopeful', mood_shift: 'lifted' },
        coercions: [{ field: 'meta_prompt', reason: 'truncated' }],
        drift: { changed: ['warmth'], capped: ['anxiety'], atBound: [], shortened: [], coerced: [], brokeDowngraded: false, applied: { warmth: 3 } },
        targets: null,
      },
      hits: ['dana'],
      outcome: { wasEnvelope: true, retried: false, silent: false, routingGate: 'skipped_memory_hit' },
      bubbles: { count: 2, overLaw: 0, maxWords: 11, hardCapped: false },
      ...over,
    },
  };
}

function turn(id: string, at: number, events: TraceEvent[]): Turn {
  return {
    id, key: 'chat1', chatId: 'chat1', handle: '+1555', source: 'user',
    startedAt: at, lastAt: at, eventCount: events.length, agents: ['convo'], open: false, events,
  };
}

test('the trace rows are the newest receipts, flattened, newest first', () => {
  const turns: Turn[] = [
    turn('t1', NOW - 3 * MIN, [traceEvent(NOW - 3 * MIN)]),
    turn('t2', NOW - 2 * MIN, [{ id: 2, ts: NOW - 2 * MIN, type: 'event', label: 'threads:select' }]),
    turn('t3', NOW - MIN, [traceEvent(NOW - MIN)]),
  ];
  const rows = traceRows(turns, 20);
  assert.equal(rows.length, 2, 'a turn with no turn:trace receipt contributes no row');
  assert.deepEqual(rows.map(r => r.turnId), ['t3', 't1']);
  const r = rows[0];
  assert.deepEqual(
    { systemChars: r.systemChars, messagesChars: r.messagesChars, share: r.transcriptShare, rows: r.transcriptRows, breakpoints: r.cacheBreakpoints },
    { systemChars: 102_700, messagesChars: 800, share: 0.0077, rows: 12, breakpoints: 2 },
  );
  assert.deepEqual(r.sections, [{ name: 'persona', chars: 90_000 }, { name: 'turn_focus', chars: 400 }]);
  assert.equal(r.threads, 'offered_theme');
  assert.deepEqual(r.memory, [{ block: 'notes', verdict: 'digest', reason: 'partly_kept', dropped: 3 }]);
  assert.equal(r.routingGate, 'skipped_memory_hit');
  assert.deepEqual(r.drift, { changed: ['warmth'], capped: ['anxiety'], atBound: [], applied: { warmth: 3 }, brokeDowngraded: false });
  assert.deepEqual({ shift: r.shift, source: r.affectSource, coercions: r.coercions }, { shift: 'lifted', source: 'emitted', coercions: 1 });
  assert.deepEqual(r.bubbles, { count: 2, overLaw: 0, maxWords: 11, hardCapped: false });
  assert.deepEqual(r.hits, ['dana']);
});

test('the row limit is honoured and a receipt with no drift claims none', () => {
  const turns = Array.from({ length: 25 }, (_, i) => turn(`t${i}`, NOW - (25 - i) * MIN, [traceEvent(NOW - (25 - i) * MIN)]));
  assert.equal(traceRows(turns, 20).length, 20);
  assert.equal(traceRows(turns, 20)[0].turnId, 't24', 'the newest 20, not the first 20');

  const noDrift = traceEvent(NOW, {
    affect: { source: 'defaulted', rawEmitted: null, coerced: null, coercions: [], drift: null, targets: null },
  });
  const row = traceRows([turn('x', NOW, [noDrift])], 20)[0];
  assert.equal(row.drift, null, 'null drift is a fact about the turn, not an empty report');
  assert.deepEqual({ shift: row.shift, source: row.affectSource }, { shift: null, source: 'defaulted' });
});

test('a corrupt or partial receipt is skipped rather than crashing the panel', () => {
  const junk: TraceEvent = { id: 9, ts: NOW, type: 'event', label: TURN_TRACE_LABEL, detail: { prompt: 'nope' } };
  assert.deepEqual(traceRows([turn('bad', NOW, [junk])], 20), []);
  const noDetail: TraceEvent = { id: 9, ts: NOW, type: 'event', label: TURN_TRACE_LABEL };
  assert.deepEqual(traceRows([turn('bad', NOW, [noDetail])], 20), []);
});
