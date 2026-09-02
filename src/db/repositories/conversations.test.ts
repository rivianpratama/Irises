// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Conversation + profile round trips on the SQLite layer: retention window,
// newest-40 cap, insertion-order ties, and the profile upsert/merge semantics.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getConversation, addMessage, clearConversation, listActiveChats, hasHistory, pruneMessagesBefore, convoHistoryMax } from './conversations.js';
import { listArchiveFor, searchArchive } from './memoryArchive.js';
import { getUserProfile, listUserProfiles, updateUserProfile, addUserFact, setUserName, clearUserProfile } from './profiles.js';
import { resetStorageForTests, stmt } from '../sqlite.js';

beforeEach(() => resetStorageForTests());

test('addMessage returns the stored timestamp; getConversation round-trips in order', async () => {
  const at1 = await addMessage('c1', 'user', 'hello', 'sam');
  const at2 = await addMessage('c1', 'assistant', 'hey!');
  assert.ok(at2 >= at1);
  const msgs = await getConversation('c1');
  assert.deepEqual(msgs.map(m => [m.role, m.content, m.handle ?? null]), [
    ['user', 'hello', 'sam'],
    ['assistant', 'hey!', null],
  ]);
  assert.equal(msgs[0].at, at1);
});

test('same-millisecond messages keep insertion order', async () => {
  // Collapse to one shared timestamp — id must break the tie.
  for (let i = 0; i < 5; i++) await addMessage('c2', 'user', `m${i}`);
  stmt('UPDATE messages SET created_at = ?').run(Date.now());
  const msgs = await getConversation('c2');
  assert.deepEqual(msgs.map(m => m.content), ['m0', 'm1', 'm2', 'm3', 'm4']);
});

test('retention: rows past 7d are invisible and pruned on the next write', async () => {
  await addMessage('c3', 'user', 'ancient');
  stmt("UPDATE messages SET created_at = created_at - 8 * 24 * 3600 * 1000 WHERE chat_id = 'c3'").run();
  assert.deepEqual(await getConversation('c3'), []);
  await addMessage('c3', 'user', 'fresh');
  const left = stmt("SELECT count(*) AS n FROM messages WHERE chat_id = 'c3'").get() as { n: number };
  assert.equal(left.n, 1); // the ancient row was hard-deleted by prune-on-write
});

test('read cap: only the newest 40 come back, oldest-first', async () => {
  for (let i = 0; i < 45; i++) await addMessage('c4', 'user', `m${i}`);
  const msgs = await getConversation('c4');
  assert.equal(msgs.length, 40);
  assert.equal(msgs[0].content, 'm5');
  assert.equal(msgs[39].content, 'm44');
});

test('CONVO_HISTORY_MAX resizes the read window, and is read at call time', async () => {
  for (let i = 0; i < 45; i++) await addMessage('c5', 'user', `m${i}`);
  assert.equal(convoHistoryMax(), 40, 'unset means the window it has always been');

  process.env.CONVO_HISTORY_MAX = '3';
  try {
    assert.equal(convoHistoryMax(), 3);
    const narrow = await getConversation('c5');
    assert.equal(narrow.length, 3, 'the same call, already imported, honors the new value');
    assert.deepEqual(narrow.map(m => m.content), ['m42', 'm43', 'm44'], 'still the newest, oldest-first');
  } finally {
    delete process.env.CONVO_HISTORY_MAX;
  }
  assert.equal((await getConversation('c5')).length, 40, 'and back to the default when unset');
});

test('a junk or non-positive CONVO_HISTORY_MAX falls back to the default window', async () => {
  for (const bad of ['', '  ', 'lots', '0', '-5', 'NaN']) {
    process.env.CONVO_HISTORY_MAX = bad;
    assert.equal(convoHistoryMax(), 40, `"${bad}" is not a window size`);
  }
  delete process.env.CONVO_HISTORY_MAX;
});

test('clearConversation deletes only that chat', async () => {
  await addMessage('a', 'user', 'keep');
  await addMessage('b', 'user', 'drop');
  await clearConversation('b');
  assert.equal((await getConversation('a')).length, 1);
  assert.deepEqual(await getConversation('b'), []);
});

test('listActiveChats: distinct chats, recency order, window cutoff, limit', async () => {
  const ins = stmt('INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?,?,?,?,?)');
  ins.run('web:a', 'user', 'a1', null, 1000);
  ins.run('web:a', 'user', 'a2', null, 3000); // a's most-recent = 3000
  ins.run('web:b', 'user', 'b1', null, 5000); // b's most-recent = 5000
  ins.run('eng:c', 'user', 'c1', null, 2000);

  // Distinct chats, ordered by most-recent activity desc.
  const all = await listActiveChats(0);
  assert.deepEqual(all.map(r => r.chatId), ['web:b', 'web:a', 'eng:c']);
  assert.equal(all.find(r => r.chatId === 'web:a')?.lastAt, 3000);

  // Window cutoff excludes chats whose newest message is at/below the bound.
  const recent = await listActiveChats(2500);
  assert.deepEqual(recent.map(r => r.chatId), ['web:b', 'web:a']);

  // Limit caps the row count (still most-recent first).
  const capped = await listActiveChats(0, 1);
  assert.deepEqual(capped.map(r => r.chatId), ['web:b']);
});

test('hasHistory: per-chat, and no time window (an old chat is still not a first hello)', async () => {
  assert.equal(await hasHistory('web:new'), false);
  await addMessage('web:seen', 'user', 'hi');
  assert.equal(await hasHistory('web:seen'), true);
  assert.equal(await hasHistory('web:new'), false, 'scoped to the chat asked about');

  // Past the 7d read window the row is still history — the contact card must not re-fire.
  stmt("UPDATE messages SET created_at = created_at - 30 * 24 * 3600 * 1000 WHERE chat_id = 'web:seen'").run();
  assert.deepEqual(await getConversation('web:seen'), [], 'invisible to the context window');
  assert.equal(await hasHistory('web:seen'), true);

  await clearConversation('web:seen');
  assert.equal(await hasHistory('web:seen'), false, 'a wiped chat is a first hello again');
});

test('profiles: upsert merge, fact dedupe, name idempotence, epoch-seconds clock', async () => {
  assert.equal(await getUserProfile('sam'), null);
  await updateUserProfile('sam', { name: 'Sam' });
  assert.equal(await addUserFact('sam', 'likes tea'), true);
  assert.equal(await addUserFact('sam', 'likes tea'), false); // dedupe
  assert.equal(await setUserName('sam', 'Sam'), false);       // unchanged → skip
  const p = await getUserProfile('sam');
  assert.equal(p?.name, 'Sam');
  assert.deepEqual(p?.facts, ['likes tea']);
  // epoch seconds, not ms
  assert.ok(p!.firstSeen > 1_000_000_000 && p!.firstSeen < 100_000_000_000);
  assert.ok(p!.lastSeen >= p!.firstSeen);
});

test('listUserProfiles orders by last_seen desc; clearUserProfile reports reality', async () => {
  await updateUserProfile('old', {});
  stmt("UPDATE user_profiles SET last_seen = last_seen - 1000 WHERE handle = 'old'").run();
  await updateUserProfile('new', {});
  const roster = await listUserProfiles();
  assert.deepEqual(roster.map(p => p.handle), ['new', 'old']);
  assert.equal(await clearUserProfile('old'), true);
  assert.equal(await clearUserProfile('old'), false); // already gone
});

// ── The prune → archive feed ─────────────────────────────────────────────────
// Conversation history is the widest feed into the cold archive: a week of thread is the raw
// material a "what did we say about that" question needs. Both prune paths archive — the daily
// retention sweep calls pruneMessagesBefore directly, and addMessage's inline keep-it-bounded
// prune goes through the same function (it used to be a bare DELETE that lost the rows).

test('pruneMessagesBefore archives what it deletes, scoped to one chat when asked', async () => {
  const at = await addMessage('prune:a', 'user', 'the roof quote came in at 8k', 'sam');
  await addMessage('prune:a', 'assistant', 'noted — 8k for the roof');
  await addMessage('prune:b', 'user', 'different chat, must survive', 'jo');

  const removed = await pruneMessagesBefore(at + 1, 'prune:a');
  assert.equal(removed, 2);
  assert.deepEqual(await getConversation('prune:a'), []);
  assert.equal((await getConversation('prune:b')).length, 1, 'the other chat is untouched');

  const archived = await listArchiveFor('sam');
  assert.equal(archived.length, 1, 'the user row is filed under their handle');
  assert.equal(archived[0].source, 'message_pruned');
  assert.equal(archived[0].chatId, 'prune:a');
  assert.equal(archived[0].meta.role, 'user');
  assert.equal(archived[0].createdAt, at);
  // The assistant row has no handle, so it is reachable by CHAT scope.
  const byChat = await searchArchive({ query: 'roof', chatId: 'prune:a' });
  assert.equal(byChat.length, 2);
});

test("addMessage's inline prune archives too (it used to be a bare DELETE)", async () => {
  await addMessage('prune:c', 'user', 'a thing said eight days ago', 'ancient');
  stmt("UPDATE messages SET created_at = created_at - 8 * 24 * 3600 * 1000 WHERE chat_id = 'prune:c'").run();

  await addMessage('prune:c', 'user', 'and something today', 'ancient');

  const left = stmt("SELECT count(*) AS n FROM messages WHERE chat_id = 'prune:c'").get() as { n: number };
  assert.equal(left.n, 1, 'the row past the window was pruned on write');
  const archived = await listArchiveFor('ancient');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].source, 'message_pruned');
  assert.equal(archived[0].content, 'a thing said eight days ago');
});

test('a prune with nothing to prune archives nothing', async () => {
  await addMessage('prune:d', 'user', 'fresh', 'nobody');
  assert.equal(await pruneMessagesBefore(0), 0);
  assert.equal((await listArchiveFor('nobody')).length, 0);
});
