import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripRawForHistory, countTurnErrors } from './diagnosticTurnHistory.js';
import type { Turn } from '../../diagnostics/turns.js';
import type { TraceEvent } from '../../diagnostics/trace.js';

function turnWith(events: Array<Partial<TraceEvent>>): Turn {
  return {
    id: 't1.abc', key: 'c1', source: 'user', startedAt: 1000, lastAt: 2000,
    eventCount: events.length, agents: [], open: false,
    events: events.map((e, i) => ({ id: i + 1, ts: 1000 + i, type: 'llm', ...e } as TraceEvent)),
  };
}

test('stripRawForHistory removes per-event raw payloads without touching the rest', () => {
  const turn = turnWith([
    { response: 'hi', raw: { huge: 'wire body' } },
    { response: 'no raw here' },
  ]);
  const stripped = stripRawForHistory(turn);
  assert.equal(stripped.events[0].raw, undefined);
  assert.equal(stripped.events[0].response, 'hi');
  assert.equal(stripped.events[1].response, 'no raw here');
  // original untouched (the live store keeps serving raw)
  assert.deepEqual(turn.events[0].raw, { huge: 'wire body' });
  // second event had no raw — same object is fine, content unchanged
  assert.equal(stripped.id, turn.id);
});

test('countTurnErrors counts ERROR responses and fidelity suppressions', () => {
  const turn = turnWith([
    { response: 'ok' },
    { response: 'ERROR: provider exploded' },
    { type: 'event', label: 'ops:fidelity-suppressed', response: null },
    { type: 'event', label: 'ops:fidelity-flagged', response: null },
  ]);
  assert.equal(countTurnErrors(turn), 2);
});
