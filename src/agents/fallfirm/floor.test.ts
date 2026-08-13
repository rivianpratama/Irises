import test from 'node:test';
import assert from 'node:assert/strict';
import { fallfirmFloor, holdingFloor, stillOnItText, heartbeatText } from './floor.js';

// The floor is the last-resort copy when even Fallfirm's model call fails — it must always return a
// non-empty, in-character line per outcome kind.

test('floor returns a non-empty line for every outcome kind', () => {
  for (const kind of ['confirmed', 'failed', 'nothing_found'] as const) {
    const line = fallfirmFloor({ kind, summary: 'x' });
    assert.ok(line && line.trim().length > 0, `empty floor for ${kind}`);
  }
});

test('confirmed floor appends facts when present', () => {
  const line = fallfirmFloor({ kind: 'confirmed', summary: 'set', facts: 'friday 9am' });
  assert.ok(line.includes('friday 9am'));
});

test('instant floors are non-empty and holdingFloor covers a known + unknown kind', () => {
  assert.ok(holdingFloor('document_read').length > 0);
  assert.ok(holdingFloor('general').length > 0); // falls to the default pool, not a fixed literal
  assert.ok(stillOnItText().length > 0);
  assert.ok(heartbeatText().length > 0);
});

test('holding/heartbeat/reassurance floors vary across repeated calls, not one fixed line', () => {
  const distinct = (calls: () => string) => new Set(Array.from({ length: 30 }, calls)).size;
  assert.ok(distinct(() => holdingFloor('document_read')) > 1, 'holdingFloor should return more than one phrasing');
  assert.ok(distinct(() => stillOnItText()) > 1, 'stillOnItText should return more than one phrasing');
  assert.ok(distinct(() => heartbeatText()) > 1, 'heartbeatText should return more than one phrasing');
});

test('heartbeatText blends in the address/deal hint at least some of the time, without always doing so', () => {
  const withHint = Array.from({ length: 40 }, () => heartbeatText({ addressHint: '412 maple st' }));
  assert.ok(withHint.some(t => t.includes('412 maple st')), 'should sometimes name the hint');
  assert.ok(withHint.some(t => !t.includes('412 maple st')), 'should sometimes stay generic too');
});
