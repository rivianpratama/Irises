import test from 'node:test';
import assert from 'node:assert/strict';
import { fallfirmFloor, holdingFloor, stillOnItText, heartbeatText, pickFresh, HOLDING, HOLDING_DEFAULT } from './floor.js';

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

// ── Fresh picks: the fallback beat never repeats one she just sent ────────────────────────────────

test('pickFresh skips what was sent recently', () => {
  assert.equal(pickFresh(['a', 'b', 'c'], ['a', 'b']), 'c');
  // Whatever the roll, a fresh item is chosen over a recent one.
  for (const r of [0, 0.5, 0.999]) assert.equal(pickFresh(['a', 'b', 'c'], ['c', 'a'], () => r), 'b');
});

test('pickFresh with every item recent returns the least recently used, never the most recent', () => {
  // `recent` is oldest first, as state/holdingBeats.ts hands it over.
  for (const r of [0, 0.5, 0.999]) {
    assert.equal(pickFresh(['a', 'b', 'c'], ['b', 'c', 'a'], () => r), 'b');
    assert.equal(pickFresh(['a', 'b', 'c'], ['a', 'c', 'b', 'a'], () => r), 'c');
  }
});

test('pickFresh refuses an empty pool plainly', () => {
  assert.throws(() => pickFresh([], []), /empty pool/);
});

test('pickFresh with no history still rolls across the whole pool', () => {
  assert.equal(pickFresh(['a', 'b', 'c'], [], () => 0), 'a');
  assert.equal(pickFresh(['a', 'b', 'c'], [], () => 0.999), 'c');
});

test('holdingFloor never repeats the beat it was just handed', () => {
  const pool = HOLDING.document_read!;
  const recent = pool.slice(0, pool.length - 1);
  for (let i = 0; i < 20; i++) assert.equal(holdingFloor('document_read', recent), pool[pool.length - 1]);
});

const HUM = /^(?:hm+|mm+|um+|uh+)\b/i;
const WAIT = /\b(?:sec|secs|min|mins|minute|moment|bit|hang on|hold on|gimme|give me)\b/i;

test('every holding pool carries a hum, a wait and variety (8+), and the default pool has 6+', () => {
  const pools: [string, readonly string[]][] = [...Object.entries(HOLDING) as [string, readonly string[]][], ['default', HOLDING_DEFAULT]];
  for (const [kind, pool] of pools) {
    assert.ok(pool.length >= 8, `${kind}: ${pool.length} lines`);
    assert.ok(pool.some(l => HUM.test(l)), `${kind}: has a hum-shaped line`);
    assert.ok(pool.some(l => WAIT.test(l)), `${kind}: has a wait-shaped line`);
    assert.equal(new Set(pool).size, pool.length, `${kind}: no duplicates`);
    for (const l of pool) {
      assert.equal(l, l.toLowerCase(), `${kind}: lowercase: ${l}`);
      assert.doesNotMatch(l, /\b(?:found|pulled|checked|tool|engine|agent|ops|hermes)\b/i, `${kind}: no claim, no internals: ${l}`);
    }
  }
  assert.ok(HOLDING_DEFAULT.length >= 6);
});
