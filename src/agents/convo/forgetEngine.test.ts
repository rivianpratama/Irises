// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The memory-boundary half of /forget me: after wiping Irises's own tiers, the flow
// ASKS the engine to forget too (same request channel as update_memory — the engine
// owns the decision; Irises never writes engine storage). Runs end-to-end against the
// ephemeral backend with a stubbed EngineBackend (repo DI convention); the confirmation
// line rides Fallfirm's hardcoded floor since no LLM is configured.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './client.js';
import { emptyMedia } from '../../webhook/types.js';
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
import { addDirective, addImportantNote, listMediumActive, listMediumAll } from '../../db/repositories/memoryMedium.js';
import { archiveEntries, listArchiveFor, searchArchive } from '../../db/repositories/memoryArchive.js';
import { addShortTerm } from '../../db/repositories/memoryShort.js';
import { saveDossier, getForgetEpoch, getMemory } from '../../db/repositories/memory.js';
import { getRelationshipClimate, saveRelationshipClimate } from '../../db/repositories/relationshipClimate.js';
import { defaultClimate } from '../../persona/climate.js';
import { stmt } from '../../db/sqlite.js';
import type { ChatContext } from './shared.js';

function stubEngine(): { engine: EngineBackend; asks: Array<{ chatId: string; handle: string; note: string }> } {
  const asks: Array<{ chatId: string; handle: string; note: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { return 'ok'; },
    async createReminder() { throw new Error('unused'); },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember(chatId, handle, note) { asks.push({ chatId, handle, note }); },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  return { engine, asks };
}

const CTX: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550009999' };

test('/forget me wipes local tiers AND fires a forget ask to the engine', async () => {
  const { engine, asks } = stubEngine();
  resetEngineBackendCache(engine);
  try {
    await addDirective('+15550009999', 'always confirm twice');
    const res = await chat('chat-forget-1', '/forget me', emptyMedia(), CTX);
    assert.ok(res.text.length > 0, 'user still gets a confirmation line');
    assert.equal((await listMediumActive('+15550009999')).length, 0, 'local medium tier wiped');
    await new Promise(r => setTimeout(r, 25)); // fire-and-forget beat
    assert.equal(asks.length, 1, 'exactly one engine ask');
    assert.equal(asks[0].chatId, 'chat-forget-1');
    assert.equal(asks[0].handle, '+15550009999');
    assert.match(asks[0].note, /forgotten|forget|remove/i);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

// The COLD half of /forget: an archive left behind would hand the forgotten memories straight
// back to recall_memory, and an expired-not-deleted short tier would archive them 48h later.
test('/forget me purges the cold archive + short tier and bumps the forget epoch', async () => {
  resetEngineBackendCache(null);
  const h = '+15550007777';
  const other = '+15550008888';
  const ctx: ChatContext = { ...CTX, senderHandle: h };
  try {
    await archiveEntries([
      { source: 'message_pruned', agentHandle: h, chatId: 'chat-forget-3', content: 'the lake cabin they call the shack' },
      { source: 'message_pruned', chatId: 'chat-forget-3', content: 'a chat-scoped row with no handle' },
      { source: 'message_pruned', agentHandle: other, chatId: 'chat-elsewhere', content: "someone else's memory" },
    ]);
    await addShortTerm({ agentHandle: h, kind: 'ops_research', content: "today's findings", taskId: 'forget-1' });
    await saveDossier(h, 'they run a print shop');
    const epochBefore = getForgetEpoch(h);

    const res = await chat('chat-forget-3', '/forget me', emptyMedia(), ctx);
    assert.ok(res.text.length > 0);

    assert.equal((await listArchiveFor(h)).length, 0, 'their archive is gone');
    assert.deepEqual(await searchArchive({ query: 'lake cabin', handle: h, chatId: 'chat-forget-3' }), [],
      'and unreachable by recall — including the chat-scoped row');
    const short = stmt('SELECT count(*) AS n FROM memory_short WHERE agent_handle = ?').get(h) as { n: number };
    assert.equal(short.n, 0, 'the short tier is DELETED, not merely expired (an expiry would archive later)');
    assert.equal((await getMemory(h))?.dossierMd, '');
    assert.equal(getForgetEpoch(h), epochBefore + 1, 'a dossier merge in flight is now fenced');

    assert.equal((await listArchiveFor(other)).length, 1, "another user's archive is untouched");
  } finally {
    resetEngineBackendCache(undefined);
  }
});

// REGRESSION: the retract-vs-purge ordering. Retraction ARCHIVES what it retracts, and the purge
// is what removes those rows — run concurrently, the purge's synchronous DELETE landed FIRST and
// the retraction's INSERT after it, so every medium row that was ACTIVE at forget time survived in
// the searchable archive and came straight back through recall_memory.
test('/forget me with ACTIVE medium rows leaves ZERO archive rows', async () => {
  resetEngineBackendCache(null);
  const h = '+15550006666';
  const ctx: ChatContext = { ...CTX, senderHandle: h };
  try {
    await addDirective(h, 'always confirm before sending');
    await addImportantNote(h, 'the gate code is 4421');
    await archiveEntries([{ source: 'message_pruned', agentHandle: h, chatId: 'chat-forget-4', content: 'an older pruned line' }]);

    const res = await chat('chat-forget-4', '/forget me', emptyMedia(), ctx);
    assert.ok(res.text.length > 0);

    assert.equal((await listArchiveFor(h)).length, 0, 'nothing survived the purge');
    assert.deepEqual(await searchArchive({ query: 'gate code', handle: h, chatId: 'chat-forget-4' }), [],
      'and the forgotten note is unreachable by recall');

    // The insert used to land a microtask LATE — after the purge had already run and after the
    // assertions above. Give it that beat and re-check.
    await new Promise(r => setTimeout(r, 25));
    assert.equal((await listArchiveFor(h)).length, 0, 'still zero once every deferred write has landed');

    assert.equal((await listMediumActive(h)).length, 0, 'the medium tier is wiped');
    assert.equal((await listMediumAll(h)).length, 2,
      'the ledger lineage survives — the leak was NOT fixed by skipping the retraction');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('/forget me does not archive another handle\'s rows', async () => {
  resetEngineBackendCache(null);
  const h = '+15550005555';
  const sibling = '+15550004444';
  const ctx: ChatContext = { ...CTX, senderHandle: h };
  try {
    await addImportantNote(h, 'their own note about the shed');
    await addDirective(sibling, 'keep it short');
    await archiveEntries([{ source: 'message_pruned', agentHandle: sibling, chatId: 'chat-sibling', content: "the sibling's pruned line" }]);

    await chat('chat-forget-5', '/forget me', emptyMedia(), ctx);
    await new Promise(r => setTimeout(r, 25));

    assert.equal((await listArchiveFor(h)).length, 0);
    assert.equal((await listArchiveFor(sibling)).length, 1, "the sibling's archive is untouched");
    assert.equal((await listMediumActive(sibling)).length, 1, "and so is their medium tier");
  } finally {
    resetEngineBackendCache(undefined);
  }
});

// The standing register is an accreted read of THIS person, so a forget takes it too. (affect_state
// surviving /forget is a known, separate quirk of its chat keying — not this test's business.)
test('/forget me resets the relationship climate to defaults', async () => {
  resetEngineBackendCache(null);
  const h = '+15550003333';
  const ctx: ChatContext = { ...CTX, senderHandle: h };
  try {
    await saveRelationshipClimate(h, {
      dials: { ease: 62, candor: 70, playfulness: 44 },
      moves: [{ at: Date.now(), k: 'ease', d: 1 }],
      lastEvalAt: Date.now(),
      evalCount: 19,
    });
    assert.equal((await getRelationshipClimate(h)).dials.ease, 62);

    const res = await chat('chat-forget-6', '/forget me', emptyMedia(), ctx);
    assert.ok(res.text.length > 0);
    await new Promise(r => setTimeout(r, 25)); // the fire-and-forget beat, as elsewhere on this path

    const after = await getRelationshipClimate(h);
    assert.deepEqual(after, defaultClimate());
    assert.deepEqual(after.moves, [], 'the rolling-window ledger goes with it');
    assert.equal(after.evalCount, 0, 'and so does the eval history');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('/forget me with no engine configured still wipes local tiers (no crash)', async () => {
  resetEngineBackendCache(null);
  try {
    await addDirective('+15550009999', 'be brief');
    const res = await chat('chat-forget-2', '/forget me', emptyMedia(), CTX);
    assert.ok(res.text.length > 0);
    assert.equal((await listMediumActive('+15550009999')).length, 0);
  } finally {
    resetEngineBackendCache(undefined);
  }
});
