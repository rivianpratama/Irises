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
import { addDirective, listMediumActive } from '../../db/repositories/memoryMedium.js';
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
    async channelSend() { /* unused */ },
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
