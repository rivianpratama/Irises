// Run with: TZ=UTC npx tsx --test src/oauth/postConnect.test.ts
//
// Covers INV-oauth-single-say: after Gmail OAuth completes, the user must never hear the same thing
// twice, and must never finish OAuth in silence. runPostConnect gates the standalone connect line
// behind the deferred re-run: a reply_in_chat re-run that delivers a message IS the single message
// (no connect line); otherwise the connect line is the fallback. voiceOutcome hits the network, so
// the app modules load via dynamic import() after the memory backend is pinned.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { OAuthRouterDeps } from './routes.js';
import type { DeferredTask } from './google.js';

let runPostConnect!: typeof import('./routes.js').runPostConnect;

before(async () => {
  ({ runPostConnect } = await import('./routes.js'));
});

const CHAT = 'chat-1';
const HANDLE = '+15551234567';

function deferred(): DeferredTask {
  return { kind: 'reply_in_chat', chatId: CHAT, agentHandle: HANDLE, request: 'pull up the Oak St offer' };
}

// Records every send and every deferred run so a test can assert exact outbound count.
function makeDeps(runResult: boolean | Error): {
  deps: OAuthRouterDeps;
  followUps: string[];
  deferredRuns: DeferredTask[];
} {
  const followUps: string[] = [];
  const deferredRuns: DeferredTask[] = [];
  const deps: OAuthRouterDeps = {
    // Mouth-faithful mock: a voicer thunk is resolved (as the real mouth does under the chat lock)
    // and an empty result is a drop, never a recorded send.
    sendFollowUp: async (_chatId, content) => {
      const text = typeof content === 'function' ? await content() : content;
      if (text) followUps.push(text);
    },
    runDeferredTask: async (task) => {
      deferredRuns.push(task);
      if (runResult instanceof Error) throw runResult;
      return runResult;
    },
  };
  return { deps, followUps, deferredRuns };
}

beforeEach(() => {
  // voiceOutcome falls to the hardcoded floor when the LLM call fails — no network, no key needed.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

test('reply_in_chat re-run that delivers a message → exactly one send, no connect line', async () => {
  const { deps, followUps, deferredRuns } = makeDeps(true);
  await runPostConnect(deps, deferred(), CHAT, HANDLE);
  assert.equal(deferredRuns.length, 1, 'deferred task ran');
  assert.equal(followUps.length, 0, 'no standalone connect line — the re-run is the single message');
});

test('reply_in_chat re-run that delivers nothing → connect line IS sent (never silence)', async () => {
  const { deps, followUps, deferredRuns } = makeDeps(false);
  await runPostConnect(deps, deferred(), CHAT, HANDLE);
  assert.equal(deferredRuns.length, 1, 'deferred task ran');
  assert.equal(followUps.length, 1, 'connect line fell back in when the re-run stayed silent');
});

test('reply_in_chat re-run that throws → connect line IS sent (never silence)', async () => {
  const { deps, followUps, deferredRuns } = makeDeps(new Error('convo blew up'));
  // The real runDeferredTask swallows errors and returns false; the helper also catches a throw as a
  // safety net so a contract-violating re-run still can't leave OAuth in silence.
  await runPostConnect(deps, deferred(), CHAT, HANDLE);
  assert.equal(deferredRuns.length, 1, 'deferred task ran');
  assert.equal(followUps.length, 1, 'connect line fell back in when the re-run threw');
});

test('no deferred task → connect line sent as before', async () => {
  const { deps, followUps, deferredRuns } = makeDeps(true);
  await runPostConnect(deps, null, CHAT, HANDLE);
  assert.equal(deferredRuns.length, 0, 'no re-run without a deferred task');
  assert.equal(followUps.length, 1, 'connect line is the single message');
});
