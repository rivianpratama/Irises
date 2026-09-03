// Run with: npm test   (DATA_BACKEND=memory). `deliver` is faked — no voicing, no LLM call — so
// this covers the announcer's own logic: the audience, the claim gate shared with the weave, which
// delivery outcomes count as told, and the text/framing split.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateAnnouncer, claimPendingUpdateNote, _internal } from './announce.js';
import { updateNoteOpening, UPDATE_NOTE_MIN_GAP_MS } from '../agents/convo/client.js';
import { _setUpdateStatusForTests, _resetCheckerForTests } from './checker.js';
import { _resetStateForTests } from './state.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { registerChannel } from '../channels/registry.js';
import { webChannel } from '../channels/web/channel.js';
import type { ProactiveMessage, ProactiveOutcome } from '../pipeline/proactiveDelivery.js';

registerChannel(webChannel); // makes web: chatIds routable (sms: stays unroutable)

function seedChat(chatId: string, at: number): void {
  stmt('INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?,?,?,?,?)').run(chatId, 'user', 'hi', null, at);
}

function makeAnnouncer(sent: ProactiveMessage[], outcome: ProactiveOutcome = 'sent') {
  const deliver = async (msg: ProactiveMessage): Promise<ProactiveOutcome> => {
    sent.push(msg);
    return outcome;
  };
  return createUpdateAnnouncer({ deliver });
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
  const sent: ProactiveMessage[] = [];
  const announcer = makeAnnouncer(sent);

  await announcer.onUpdateDetected('sha1');
  assert.deepEqual(sent.map(m => m.chatId), ['web:b', 'web:a']);
  // The update note rides the same proactive door as an engine push, as its own kind.
  assert.deepEqual([...new Set(sent.map(m => m.kind))], ['update']);
  // Per-moment, per-chat dedupe key: a re-detect of the same build can never double-tell a chat.
  assert.deepEqual(sent.map(m => m.dedupeKey), ['update:availability:sha1:web:b', 'update:availability:sha1:web:a']);

  await announcer.onUpdateDetected('sha1'); // already claimed → no repeat
  assert.equal(sent.length, 2);
});

test('UPDATE_ANNOUNCE_ENABLED=false sends nothing', async () => {
  process.env.UPDATE_ANNOUNCE_ENABLED = 'false';
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha1', updateAvailable: true });
  const sent: ProactiveMessage[] = [];
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
  const sent: ProactiveMessage[] = [];
  await makeAnnouncer(sent).onUpdateDetected('sha3');
  assert.deepEqual(sent.map(m => m.chatId), ['web:b']);
});

test("a 'failed' delivery releases the claim so the weave can still recover it", async () => {
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha4', updateAvailable: true });
  await createUpdateAnnouncer({ deliver: async () => 'failed' }).onUpdateDetected('sha4');
  // claim was released → the weave can still get the note for this chat/version
  assert.ok(claimPendingUpdateNote('web:a'));
});

test("a thrown delivery also releases the claim", async () => {
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha5', updateAvailable: true });
  await createUpdateAnnouncer({ deliver: async () => { throw new Error('bridge down'); } }).onUpdateDetected('sha5');
  assert.ok(claimPendingUpdateNote('web:a'));
});

test("'deferred' and 'duplicate' hold the claim — the chat is told, or was already", async () => {
  seedChat('web:a', Date.now() - 1000);
  _setUpdateStatusForTests({ remoteSha: 'sha6', updateAvailable: true });
  await createUpdateAnnouncer({ deliver: async () => 'deferred' }).onUpdateDetected('sha6');
  assert.equal(claimPendingUpdateNote('web:a'), null, 'a parked note is not a lost note');

  _resetStateForTests();
  _setUpdateStatusForTests({ remoteSha: 'sha7', updateAvailable: true });
  await createUpdateAnnouncer({ deliver: async () => 'duplicate' }).onUpdateDetected('sha7');
  assert.equal(claimPendingUpdateNote('web:a'), null);
});

test('the weave waits for an opening rather than landing mid-conversation', () => {
  // The claim gate is shared, so WHERE Convo claims decides whether the note interrupts. It used to
  // claim on whatever turn happened to come next — including the third message of a live back and
  // forth, where "by the way, you have an upgrade waiting" is the reply arriving instead of an
  // answer. The note is one-off and unrepeatable, so this is not about suppressing it: an opening
  // comes around within the hour, and the note is still there when it does.
  assert.equal(updateNoteOpening(Infinity, 0), true, 'their very first message ever');
  assert.equal(updateNoteOpening(UPDATE_NOTE_MIN_GAP_MS, 40), true, 'exactly at the gap');
  assert.equal(updateNoteOpening(4 * 3600_000, 40), true, 'a quiet afternoon');
  assert.equal(updateNoteOpening(60_000, 40), false, 'a minute into a live thread');
  assert.equal(updateNoteOpening(Infinity, 40), true, 'an undated history reads as no idea how long, which passes');
});

test('a note left unclaimed mid-conversation is still there at the next opening', () => {
  _setUpdateStatusForTests({ remoteSha: 'sha9', updateAvailable: true });
  // The mid-conversation turn does not call claim at all — that half is by INSPECTION, not by this
  // test: convo/client.ts guards the claim behind this helper, and chat() cannot be driven without
  // reaching a model. What runs here is the helper alone: it refuses the mid-conversation turn…
  assert.equal(updateNoteOpening(60_000, 12), false);
  // …and the next turn with a real opening still gets it.
  assert.ok(updateNoteOpening(45 * 60_000, 12));
  assert.ok(claimPendingUpdateNote('web:weave'));
});

test('builders: availability carries the exact command as relayed text; the changelog stays in framing', () => {
  const text = _internal.availabilityText('abc1234');
  assert.match(text, /bash scripts\/update\.sh/);
  assert.match(text, /abc1234/);
  assert.match(_internal.availabilityFraming(), /once/);

  assert.equal(_internal.upgradedText('bbbbbbb'), 'now on build bbbbbbb');
  const framing = _internal.upgradedFraming({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), appliedAt: 'x', changes: ['secret1 fix', 'secret2 feat'] });
  // Commit subjects are DEV copy: they ride the framing (voiced), never the relayed-exactly text.
  assert.match(framing, /secret1 fix/);
  assert.doesNotMatch(_internal.upgradedText('bbbbbbb'), /secret/);
});
