import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addEvent, getTurns, getLatestTurns, clearTurns, setOnTurnChange } from './turns.js';
import type { TraceEvent } from './trace.js';

let seq = 0;
function ev(partial: Partial<TraceEvent>): TraceEvent {
  return { id: ++seq, ts: Date.now(), type: 'llm', ...partial } as TraceEvent;
}

beforeEach(() => { clearTurns(); setOnTurnChange(null); });

test('turn:start opens a new turn and captures the trigger text', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', handle: '+1555', detail: { text: 'hello irises' } }));
  addEvent(ev({ label: 'convo', chatId: 'c1', handle: '+1555', response: 'hey!' }));
  const turns = getTurns('c1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].trigger, 'hello irises');
  assert.equal(turns[0].source, 'user');
  assert.equal(turns[0].events.length, 2);
  assert.ok(turns[0].agents.includes('convo'));
});

test('a second turn:start closes the previous turn', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'first' } }));
  addEvent(ev({ label: 'convo', chatId: 'c1' }));
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'second' } }));
  const turns = getTurns('c1');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].open, false);
  assert.equal(turns[1].open, true);
  assert.equal(turns[1].trigger, 'second');
});

test('late Ops events route back to the delegating turn via taskId, past a newer turn', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'look up the pine st deal' } }));
  addEvent(ev({ type: 'delegation', label: 'delegate:deal_lookup', chatId: 'c1', taskId: 'task-9' }));
  // user sends another message before Ops finishes
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'thanks!' } }));
  addEvent(ev({ label: 'convo', chatId: 'c1' }));
  // Ops finishes late — must land on turn 1, not turn 2
  addEvent(ev({ label: 'ops:step0', chatId: 'c1', taskId: 'task-9', role: 'ops' }));
  addEvent(ev({ label: 'composer', chatId: 'c1', taskId: 'task-9', response: 'here you go' }));
  const [t1, t2] = getTurns('c1');
  assert.equal(t1.events.length, 4);
  assert.ok(t1.agents.includes('ops:step0'));
  assert.ok(t1.agents.includes('composer'));
  assert.equal(t2.events.length, 2);
});

test('chat-less judge events key by handle and infer email source', () => {
  addEvent(ev({ label: 'judge', handle: '+1555', role: 'judge', response: 'important email' }));
  const turns = getTurns('handle:+1555');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].source, 'email');
});

test('events with neither chatId nor handle are ignored by the turn store', () => {
  addEvent(ev({ label: 'classify:effect' }));
  assert.equal(getLatestTurns().length, 0);
});

test('getLatestTurns returns one turn per key, newest activity first', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'a' }, ts: 1000 }));
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c2', detail: { text: 'b' }, ts: 2000 }));
  const latest = getLatestTurns();
  assert.equal(latest.length, 2);
  assert.equal(latest[0].key, 'c2');
  assert.equal(latest[1].key, 'c1');
});

test('onTurnChange fires for every appended event', () => {
  const seen: string[] = [];
  setOnTurnChange(t => seen.push(t.id));
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'x' } }));
  addEvent(ev({ label: 'convo', chatId: 'c1' }));
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen).size, 1); // same turn both times
});

test('turns per key are capped', () => {
  for (let i = 0; i < 15; i++) {
    addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: `m${i}` } }));
  }
  assert.ok(getTurns('c1').length <= 10);
  const last = getTurns('c1').at(-1)!;
  assert.equal(last.trigger, 'm14');
});

test('turn ids carry a boot suffix (history upsert key must survive restarts)', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'a' } }));
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'b' } }));
  const [t1, t2] = getTurns('c1');
  // t<seq>.<boot> — same boot id within a process, distinct seq
  assert.match(t1.id, /^t\d+\.[a-z0-9]+$/);
  assert.match(t2.id, /^t\d+\.[a-z0-9]+$/);
  assert.notEqual(t1.id, t2.id);
  assert.equal(t1.id.split('.')[1], t2.id.split('.')[1]);
});

test('onTurnChange receives the CHANGED turn when a late event lands on an older turn', () => {
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'first' } }));
  addEvent(ev({ type: 'delegation', label: 'delegate:deal_lookup', chatId: 'c1', taskId: 'task-1' }));
  addEvent(ev({ type: 'event', label: 'turn:start', chatId: 'c1', detail: { text: 'second' } }));
  const [older, newer] = getTurns('c1');
  const changed: string[] = [];
  setOnTurnChange(t => changed.push(t.id));
  addEvent(ev({ label: 'ops:step0', chatId: 'c1', taskId: 'task-1', role: 'ops' }));
  assert.deepEqual(changed, [older.id]);
  assert.notEqual(older.id, newer.id);
});
