// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The rhythm ledger's storage doctrine: reads DEGRADE rather than throw (this sits on the reply
// path), an unreadable kind is dropped rather than invented, the key is the CHAT so a room keeps its
// own rhythm, and a /forget that lands mid-turn fences the save that would otherwise put back the
// rhythm the user asked to be forgotten.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import {
  getHookState, saveHookState, clearHookState, clearHookStateForHandle,
} from './hookState.js';
import { bumpForgetEpoch, getForgetEpoch } from './memory.js';
import { defaultHookState, type HookState } from '../../persona/hooks.js';

beforeEach(() => resetStorageForTests());

const T0 = Date.UTC(2026, 0, 1);

/** A ledger with something worth losing in every field. */
function rich(over: Partial<HookState> = {}): HookState {
  return { lastKinds: ['none', 'judgment', 'callback'], idleStreak: 4, idleSinceMoment: 2, updatedAt: T0, ...over };
}

/** Write a row straight past the repository, so a corrupt/hand-built row can be tested. */
function rawRow(chatId: string, stateJson: string, handle = ''): void {
  stmt('INSERT INTO hook_state (chat_id, handle, state_json, updated_at) VALUES (?, ?, ?, ?)')
    .run(chatId, handle, stateJson, Date.now());
}

test('an unknown chat reads back the default state', async () => {
  assert.deepEqual(await getHookState('chat-hooks-unknown'), defaultHookState());
});

test('save then get round-trips the window, the streak and the moment clock', async () => {
  const chatId = 'chat-hooks-1';
  assert.equal(await saveHookState(chatId, '+15551110001', rich()), true);
  assert.deepEqual(await getHookState(chatId), rich());

  // Upsert, not insert: the second write replaces the first for the same chat.
  assert.equal(await saveHookState(chatId, '+15551110001', rich({ lastKinds: ['tangent'], idleStreak: 0 })), true);
  const back = await getHookState(chatId);
  assert.deepEqual(back.lastKinds, ['tangent']);
  assert.equal(back.idleStreak, 0);
});

test('a mangled blob degrades to the default state rather than throwing', async () => {
  const chatId = 'chat-hooks-2';
  rawRow(chatId, '{not json at all');
  assert.deepEqual(await getHookState(chatId), defaultHookState());
  // A readable blob of the wrong SHAPE degrades the same way.
  rawRow('chat-hooks-3', '["judgment","callback"]');
  assert.deepEqual(await getHookState('chat-hooks-3'), defaultHookState());
  rawRow('chat-hooks-4', 'null');
  assert.deepEqual(await getHookState('chat-hooks-4'), defaultHookState());
});

// Degrading can only ever open a hook back UP, never force a quiet turn onto someone who never
// earned one — which is why an unreadable kind is DROPPED rather than coerced to `none`: inventing
// a `none` would hand back a hook the kill switch had already taken away.
test('an unreadable kind is dropped, its siblings kept, and the window stays capped', async () => {
  rawRow('chat-hooks-5', JSON.stringify({
    lastKinds: ['judgment', 'vibes', 'callback', null, 'tangent'],
    idleStreak: 2, idleSinceMoment: 1, updatedAt: T0,
  }));
  const s = await getHookState('chat-hooks-5');
  assert.deepEqual(s.lastKinds, ['judgment', 'callback', 'tangent'], 'the tail of what survived, cap applied');

  rawRow('chat-hooks-6', JSON.stringify({ lastKinds: 'judgment', idleStreak: 1 }));
  assert.deepEqual((await getHookState('chat-hooks-6')).lastKinds, []);
});

test('a garbled counter is coerced back into range rather than costing the row', async () => {
  rawRow('chat-hooks-7', JSON.stringify({
    lastKinds: ['callback'], idleStreak: -3, idleSinceMoment: 'lots', updatedAt: -99,
  }));
  const s = await getHookState('chat-hooks-7');
  assert.deepEqual(s.lastKinds, ['callback'], 'the window survives the bad counters beside it');
  assert.equal(s.idleStreak, 0);
  assert.equal(s.idleSinceMoment, 0, 'a negative moment clock would hold a callback back forever');
  assert.equal(s.updatedAt, 0);
});

test('a hand-built state is coerced on the way IN as well as out', async () => {
  const chatId = 'chat-hooks-8';
  assert.equal(await saveHookState(chatId, '+15551110002', {
    lastKinds: ['judgment', 'shrug', 'callback', 'tangent'] as never,
    idleStreak: -1, idleSinceMoment: 3.7, updatedAt: T0,
  }), true);
  const s = await getHookState(chatId);
  assert.deepEqual(s.lastKinds, ['judgment', 'callback', 'tangent']);
  assert.equal(s.idleStreak, 0);
  assert.equal(s.idleSinceMoment, 3, 'truncated, not rounded up — the clock never runs fast');
  // And nothing unknown reached the column for a later read to trust.
  const row = stmt('SELECT state_json FROM hook_state WHERE chat_id = ?').get(chatId) as { state_json: string };
  assert.equal(row.state_json.includes('shrug'), false);
});

test('the forget epoch fence refuses a save that started before the wipe', async () => {
  const chatId = 'chat-hooks-9';
  const h = '+15551110003';
  const epoch0 = getForgetEpoch(h);
  assert.equal(await saveHookState(chatId, h, rich(), { ifForgetEpoch: epoch0 }), true);
  assert.equal((await getHookState(chatId)).idleStreak, 4);

  // A /forget lands. The in-flight turn's ledger write now carries a stale epoch.
  bumpForgetEpoch(h);
  await clearHookState(chatId);
  assert.equal(await saveHookState(chatId, h, rich(), { ifForgetEpoch: epoch0 }), false);
  assert.deepEqual(await getHookState(chatId), defaultHookState(), 'the wipe stands');
  const row = stmt('SELECT count(*) AS n FROM hook_state WHERE chat_id = ?').get(chatId) as { n: number };
  assert.equal(row.n, 0, 'and nothing at all was written');

  // Without the fence (or with a current one) the same write lands.
  assert.equal(await saveHookState(chatId, h, rich(), { ifForgetEpoch: getForgetEpoch(h) }), true);
});

test('clear by chat drops the row back to defaults', async () => {
  const chatId = 'chat-hooks-10';
  await saveHookState(chatId, '+15551110004', rich());
  await clearHookState(chatId);
  assert.deepEqual(await getHookState(chatId), defaultHookState());
  // Clearing a chat that was never there is a no-op, not an error.
  await clearHookState('chat-hooks-never');
});

// The dashboard's seam: a surface that knows the handle and not the chat ids still wipes the rhythm
// in every room the handle reached — and touches nobody else's.
test('clear by handle sweeps every room that handle reached, and only those', async () => {
  const h = '+15551110005';
  await saveHookState('chat-hooks-11', h, rich());
  await saveHookState('chat-hooks-12', h, rich({ idleStreak: 1 }));
  await saveHookState('chat-hooks-13', '+15551110006', rich({ idleStreak: 7 }));

  await clearHookStateForHandle(h);
  assert.deepEqual(await getHookState('chat-hooks-11'), defaultHookState());
  assert.deepEqual(await getHookState('chat-hooks-12'), defaultHookState());
  assert.equal((await getHookState('chat-hooks-13')).idleStreak, 7, "a stranger's rhythm is untouched");

  // A handle that never wrote a row sweeps nothing and complains about nothing.
  await clearHookStateForHandle('+15551119999');
});

// Rhythm belongs to the ROOM. Two chats the same person is in keep separate ledgers, and the
// `handle` column is the sweep key rather than the identity — so a room that several people typed
// into is still ONE ledger.
test('the ledger is keyed by chat, not by handle', async () => {
  const h = '+15551110007';
  await saveHookState('chat-hooks-14', h, rich({ idleStreak: 5 }));
  await saveHookState('chat-hooks-15', h, rich({ idleStreak: 1 }));
  assert.equal((await getHookState('chat-hooks-14')).idleStreak, 5);
  assert.equal((await getHookState('chat-hooks-15')).idleStreak, 1);
  assert.deepEqual(await getHookState(h), defaultHookState(), 'the handle is not a chat id');

  // A group row: the second speaker's write lands on the same row, and the ledger accumulates.
  await saveHookState('chat-hooks-16', '+15551110008', rich({ lastKinds: ['judgment'] }));
  await saveHookState('chat-hooks-16', '+15551110009', rich({ lastKinds: ['judgment', 'callback'] }));
  assert.deepEqual((await getHookState('chat-hooks-16')).lastKinds, ['judgment', 'callback']);
  const row = stmt('SELECT handle FROM hook_state WHERE chat_id = ?').get('chat-hooks-16') as { handle: string };
  assert.equal(row.handle, '+15551110009', 'whichever handle spoke last is enough to find the room');
});
