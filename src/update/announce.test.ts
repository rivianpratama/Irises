// Run with: npm test   (DATA_BACKEND=memory). sendFollowUp is faked and its voice thunk is never
// invoked, so no LLM call happens; the audience comes from the real in-memory messages table.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateAnnouncer, claimPendingUpdateNote, _internal } from './announce.js';
import { _setUpdateStatusForTests, _resetCheckerForTests } from './checker.js';
import { _resetStateForTests } from './state.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { registerChannel } from '../channels/registry.js';
import { webChannel } from '../channels/web/channel.js';
import type { SpeakContent, SpeakOpts, SpeakResult } from '../state/mouth.js';

registerChannel(webChannel); // makes web: chatIds routable (sms: stays unroutable)

function seedChat(chatId: string, at: number): void {
  stmt('INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?,?,?,?,?)').run(chatId, 'user', 'hi', null, at);
}

function makeAnnouncer(sent: string[]) {
  const sendFollowUp = async (chatId: string, _c: SpeakContent, _o?: SpeakOpts): Promise<SpeakResult> => {
    sent.push(chatId); // note: we do NOT call the voice thunk → no LLM
    return 'sent';
  };
  return createUpdateAnnouncer({ sendFollowUp });
}

beforeEach(() => {
  resetStorageForTests();
  _resetStateForTests();
  _resetCheckerForTests();
  delete process.env.UPDATE_ANNOUNCE_ENABLED;
});

test('onUpdateDetected announces once to each routable active chat, skipping unroutable', async () => {
  const now = Date.now();
  seedChat('web:a', now - 2000);
  seedChat('web:b', now - 1000); // more recent → first
  seedChat('sms:x', now - 500);  // unroutable → skipped
  _setUpdateStatusForTests({ remoteSha: 'sha1', updateAvailable: true });
  const sent: string[] = [];
  const announcer = makeAnnouncer(sent);

  await announcer.onUpdateDetected('sha1');
  assert.deepEqual(sent, ['web:b', 'web:a']);

  await announcer.onUpdateDetected('sha1'); // already claimed → no repeat
  assert.deepEqual(sent, ['web:b', 'web:a']);
});

test('UPDATE_ANNOUNCE_ENABLED=false sends nothing', async () => {
  process.env.UPDATE_ANNOUNCE_ENABLED = 'false';
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha1', updateAvailable: true });
  const sent: string[] = [];
  await makeAnnouncer(sent).onUpdateDetected('sha1');
  assert.deepEqual(sent, []);
});

test('claimPendingUpdateNote returns the woven note once, then null', () => {
  _setUpdateStatusForTests({ remoteSha: 'sha2', updateAvailable: true });
  const note = claimPendingUpdateNote('web:q');
  assert.ok(note);
  assert.match(note!, /bash scripts\/update\.sh/);
  assert.equal(claimPendingUpdateNote('web:q'), null); // claimed
});

test('no note when no update is pending', () => {
  _setUpdateStatusForTests({ remoteSha: null, updateAvailable: false });
  assert.equal(claimPendingUpdateNote('web:a'), null);
});

test('weave and push are mutually exclusive per chat (whoever claims first wins)', async () => {
  const now = Date.now();
  seedChat('web:a', now - 2000);
  seedChat('web:b', now - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha3', updateAvailable: true });

  // web:a gets the woven note first (claims sha3:web:a)
  assert.ok(claimPendingUpdateNote('web:a'));

  // the cold push then skips web:a and only reaches web:b
  const sent: string[] = [];
  await makeAnnouncer(sent).onUpdateDetected('sha3');
  assert.deepEqual(sent, ['web:b']);
});

test('a failed push delivery releases the claim so the weave can still recover it', async () => {
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha4', updateAvailable: true });
  const failing = createUpdateAnnouncer({ sendFollowUp: async () => { throw new Error('bridge down'); } });
  await failing.onUpdateDetected('sha4');
  // claim was released on the failed send → the weave can still get the note for this chat/version
  assert.ok(claimPendingUpdateNote('web:a'));
});

test('outcome builders: availability carries the exact command in facts; upgrade keeps changelog out of facts', () => {
  const avail = _internal.availabilityOutcome('abc1234');
  assert.equal(avail.kind, 'confirmed');
  assert.match(avail.facts!, /bash scripts\/update\.sh/);
  assert.match(avail.facts!, /abc1234/);

  const upgraded = _internal.upgradedOutcome({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), appliedAt: 'x', changes: ['secret1 fix', 'secret2 feat'] }, 'bbbbbbb');
  assert.equal(upgraded.kind, 'confirmed');
  assert.equal(upgraded.facts, 'now on build bbbbbbb');
  assert.doesNotMatch(upgraded.facts!, /secret/);      // commit subjects never ride facts (verbatim)
  assert.match(upgraded.summary, /secret1 fix/);        // they ride summary (voiced)
});
