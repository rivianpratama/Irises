import { Router } from 'express';
import { consumeOAuthState } from '../db/repositories/oauth.js';
import { exchangeCodeForTokens, DeferredTask } from './google.js';
import { voiceOutcome } from '../agents/fallfirm/client.js';

export interface OAuthRouterDeps {
  // The mouth contract (state/mouth.ts): a voicer thunk runs only once it owns the per-chat lock,
  // so the connect line is voiced against the thread as it actually is when it speaks.
  sendFollowUp: (chatId: string, content: string | (() => Promise<string | null>)) => Promise<unknown>;
  // Returns true when the re-run itself put an outbound message in chat.
  runDeferredTask: (task: DeferredTask) => Promise<boolean>;
  onConnected?: (handle: string, chatId: string) => void; // first-connect backfill hook
}

/**
 * Post-connect follow-up. A reply_in_chat deferred re-run replies for itself and implicitly confirms
 * the connection, so the standalone connect line is the FALLBACK — sent only when there is no deferred
 * re-run or when the re-run delivered nothing (INV-oauth-single-say: OAuth must never end in silence,
 * and the user must never hear the same thing twice).
 */
export async function runPostConnect(
  deps: OAuthRouterDeps,
  deferred: DeferredTask | null,
  chatId: string,
  handle: string,
): Promise<void> {
  try {
    // A reply_in_chat re-run speaks for itself; let it be the single message when it delivers one.
    // A false return (or a throw the contract shouldn't produce) means it said nothing — fall through.
    if (deferred?.kind === 'reply_in_chat') {
      let delivered = false;
      try { delivered = await deps.runDeferredTask(deferred); }
      catch (e) { console.error('[oauth] deferred re-run failed', e); }
      if (delivered) return;
    }
    // No re-run, or the re-run said nothing — Fallfirm voices the connect confirmation in Irises's
    // tone, under the mouth: voiced only once it owns the chat lock, so it reads (and lands on) the
    // thread as it actually is, never a snapshot from before a queued reply.
    await deps.sendFollowUp(chatId, () => voiceOutcome({
      kind: 'confirmed',
      summary: 'their gmail is now connected',
      originalRequest: deferred?.request,
    }, chatId, handle));
  } catch (e) {
    console.error('[oauth] post-connect follow-up failed', e);
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1.5rem;text-align:center;color:#111}h1{font-size:1.4rem}p{color:#555}</style>` +
  `</head><body>${body}</body></html>`;

const SUCCESS = PAGE('Gmail connected', '<h1>✅ Gmail connected</h1><p>You can close this tab and head back to your chat — Irises can read your email now (read-only).</p>');

const EXPIRED = PAGE('Link expired', '<h1>This link expired</h1><p>Text Irises again and he\'ll send a fresh connect link.</p>');
const DENIED = PAGE('Not connected', '<h1>No problem</h1><p>You can connect Gmail later — just ask Irises.</p>');

export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const router = Router();

  router.get('/oauth/google/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';

    if (error) { res.status(200).send(DENIED); return; }
    if (!code || !state) { res.status(400).send(EXPIRED); return; }

    const consumed = await consumeOAuthState(state);
    if (!consumed) { res.status(400).send(EXPIRED); return; }

    try {
      await exchangeCodeForTokens(consumed.handle, code);
    } catch (err) {
      console.error('[oauth] token exchange failed', err);
      res.status(400).send(EXPIRED);
      return;
    }

    res.status(200).send(SUCCESS);

    // Fire-and-forget: backfill their inbox, then the post-connect follow-up.
    const deferred = consumed.deferredTask as unknown as DeferredTask | null;
    deps.onConnected?.(consumed.handle, consumed.chatId);
    void runPostConnect(deps, deferred, consumed.chatId, consumed.handle);
  });

  return router;
}
