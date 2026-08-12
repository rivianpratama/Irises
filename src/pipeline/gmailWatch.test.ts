// Run with: npm test  (TZ=UTC tsx --test). On Windows: $env:TZ='UTC'; npx tsx --test "src/**/*.test.ts"
//
// Exercises disconnectGmail on the in-memory backend. DATA_BACKEND must be 'memory' BEFORE
// db/client.ts loads (it picks its driver once at module-eval time), so the app modules are pulled
// in via dynamic import() inside a before() hook rather than static imports. The seeded refresh
// token is deliberately un-decryptable, so the best-effort Google-side steps (stopWatch /
// revokeGoogleGrant) fail fast on decrypt and make NO network calls, while the local teardown
// (token revoke + pref clearing) still runs and is asserted.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
delete process.env.TOKEN_ENCRYPTION_KEY;

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

let mem!: typeof import('../db/memory.js').mem;
let disconnectGmail!: typeof import('./gmailWatch.js').disconnectGmail;
let getGmailToken!: typeof import('../db/repositories/tokens.js').getGmailToken;
let listConnectedHandles!: typeof import('../db/repositories/tokens.js').listConnectedHandles;
let getMemory!: typeof import('../db/repositories/memory.js').getMemory;

before(async () => {
  ({ mem } = await import('../db/memory.js'));
  ({ disconnectGmail } = await import('./gmailWatch.js'));
  ({ getGmailToken, listConnectedHandles } = await import('../db/repositories/tokens.js'));
  ({ getMemory } = await import('../db/repositories/memory.js'));
});

function seedConnected(handle: string): void {
  mem.gmailTokens.set(handle, {
    handle,
    refreshTokenEnc: Buffer.from('not-a-real-encrypted-token'),
    accessTokenEnc: null,
    accessTokenExpiry: null,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    googleEmail: `${handle}@example.com`,
    revoked: false,
  });
  mem.agentMemory.set(handle, {
    handle,
    dossierMd: '',
    prefs: {
      chat_id: `chat-${handle}`,
      gmail_declined: false,
      gmail_address: `${handle}@example.com`,
      gmail_watch_history_id: '12345',
      gmail_watch_expiration: '1799999999000',
      email_watermark: 1700000000000,
      email_ingested: true,
      surfaced_email_ids: ['m1', 'm2'],
      pending_email_contexts: [{ subject: 'inspection deadline' }],
    },
  });
}

test('disconnectGmail revokes the token, stops monitoring, and clears cached email state', async () => {
  const handle = 'discon1';
  seedConnected(handle);

  const result = await disconnectGmail(handle);
  assert.equal(result.wasConnected, true);

  // Token is revoked → reads as not connected, and the poller stops seeing it.
  assert.equal(await getGmailToken(handle), null);
  assert.equal((await listConnectedHandles()).includes(handle), false);

  const prefs = (await getMemory(handle))!.prefs;
  // chat_id is preserved so background jobs can still reach the user.
  assert.equal(prefs.chat_id, `chat-${handle}`);
  // All Gmail-connection / cached-email state is cleared.
  assert.equal(prefs.gmail_address, null);
  assert.equal(prefs.gmail_watch_history_id, null);
  assert.equal(prefs.gmail_watch_expiration, null);
  assert.equal(prefs.email_watermark, null);
  assert.equal(prefs.email_ingested, null);
  assert.equal(prefs.surfaced_email_ids, null);
  assert.equal(prefs.pending_email_contexts, null);
  // gmail_declined is intentionally untouched (disconnecting != declining onboarding).
  assert.equal(prefs.gmail_declined, false);
});

test('disconnectGmail is an idempotent no-op when Gmail is not connected', async () => {
  const handle = 'discon2';
  // No token seeded → reports not connected without throwing.
  assert.equal((await disconnectGmail(handle)).wasConnected, false);

  // After a real disconnect, a repeat call also reports not-connected.
  seedConnected(handle);
  assert.equal((await disconnectGmail(handle)).wasConnected, true);
  assert.equal((await disconnectGmail(handle)).wasConnected, false);
});
