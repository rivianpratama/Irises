// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Conversation + profile round trips on the SQLite layer: retention window,
// newest-40 cap, insertion-order ties, and the profile upsert/merge semantics.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getConversation, addMessage, clearConversation } from './conversations.js';
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

test('clearConversation deletes only that chat', async () => {
  await addMessage('a', 'user', 'keep');
  await addMessage('b', 'user', 'drop');
  await clearConversation('b');
  assert.equal((await getConversation('a')).length, 1);
  assert.deepEqual(await getConversation('b'), []);
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
