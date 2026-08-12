import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { encryptToken, decryptToken } from './crypto.js';
import { createOAuthState } from '../db/repositories/oauth.js';
import { saveGmailToken, getGmailToken, revokeGmailToken } from '../db/repositories/tokens.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

export class GmailReauthRequired extends Error {
  constructor(public handle: string) { super(`Gmail re-auth required for ${handle}`); }
}

export interface DeferredTask {
  kind: 'reply_in_chat';
  chatId: string;
  agentHandle: string;
  request: string;
}

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

/** Create a one-shot state row + consent URL for the in-chat OAuth flow. */
export async function createConsentLink(
  handle: string,
  chatId: string,
  deferredTask?: DeferredTask,
): Promise<string> {
  const state = await createOAuthState(handle, chatId, deferredTask as unknown as Record<string, unknown>);
  const client = makeOAuthClient();
  // access_type:offline + prompt:consent guarantee a refresh token even on re-consent.
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

/** Exchange the auth code and persist the encrypted refresh token. */
export async function exchangeCodeForTokens(
  handle: string,
  code: string,
): Promise<{ googleEmail: string | null }> {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);

  // Try to read the authorized email (best-effort).
  let googleEmail: string | null = null;
  try {
    if (tokens.access_token) {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const info = await oauth2.userinfo.get();
      googleEmail = info.data.email ?? null;
    }
  } catch { /* non-fatal */ }

  if (!tokens.refresh_token) {
    // Re-consent without a new refresh token — keep the existing one if present.
    const existing = await getGmailToken(handle);
    if (!existing) throw new Error('Google did not return a refresh token; ask the user to reconnect.');
    return { googleEmail: existing.googleEmail };
  }

  await saveGmailToken(handle, {
    refreshTokenEnc: encryptToken(tokens.refresh_token),
    accessTokenEnc: tokens.access_token ? encryptToken(tokens.access_token) : null,
    accessTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scope: SCOPES.join(' '),
    googleEmail,
  });
  return { googleEmail };
}

/** Build an authenticated Gmail client for a handle. Throws GmailReauthRequired if not connected/revoked. */
export async function getGmailClientForHandle(handle: string): Promise<gmail_v1.Gmail> {
  const token = await getGmailToken(handle);
  if (!token) throw new GmailReauthRequired(handle);

  const client = makeOAuthClient();
  client.setCredentials({
    refresh_token: decryptToken(token.refreshTokenEnc),
    access_token: token.accessTokenEnc ? decryptToken(token.accessTokenEnc) : undefined,
    expiry_date: token.accessTokenExpiry ? Date.parse(token.accessTokenExpiry) : undefined,
  });

  // Persist rotated tokens when googleapis silently refreshes.
  client.on('tokens', (t) => {
    void saveGmailToken(handle, {
      refreshTokenEnc: t.refresh_token ? encryptToken(t.refresh_token) : token.refreshTokenEnc,
      accessTokenEnc: t.access_token ? encryptToken(t.access_token) : token.accessTokenEnc,
      accessTokenExpiry: t.expiry_date ? new Date(t.expiry_date).toISOString() : token.accessTokenExpiry,
      scope: token.scope,
      googleEmail: token.googleEmail,
    }).catch(e => console.error('[oauth] failed to persist rotated token', e));
  });

  return google.gmail({ version: 'v1', auth: client });
}

/** Verify access works; on invalid_grant mark revoked and surface reauth. */
export async function assertGmailAccess(handle: string): Promise<gmail_v1.Gmail> {
  try {
    const gmail = await getGmailClientForHandle(handle);
    await gmail.users.getProfile({ userId: 'me' });
    return gmail;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked')) {
      await revokeGmailToken(handle);
      throw new GmailReauthRequired(handle);
    }
    throw err;
  }
}

/**
 * Best-effort: revoke the grant at Google so the user truly stops sharing (not just locally).
 * Revoking the refresh token invalidates the whole grant (and derived access tokens) at Google's
 * /revoke endpoint. NEVER throws — a Google hiccup must not block the local disconnect, and callers
 * flip the local token afterwards. Must run while the token is still live (before revokeGmailToken).
 */
export async function revokeGoogleGrant(handle: string): Promise<void> {
  try {
    const token = await getGmailToken(handle);
    if (!token) return;
    const client = makeOAuthClient();
    client.setCredentials({ refresh_token: decryptToken(token.refreshTokenEnc) });
    await client.revokeCredentials();
  } catch (err) {
    console.warn(`[oauth] best-effort Google revoke failed for ${handle} (continuing)`, err);
  }
}
