import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import type { GmailToken, GmailTokenInput } from '../types.js';

// Supabase stores bytea; supabase-js round-trips it as a hex string ("\\x...").
// We store/read base64 in a JSON-safe way by hex-encoding here.
function bufToHex(b: Buffer): string {
  return '\\x' + b.toString('hex');
}
function hexToBuf(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  const s = String(v ?? '');
  return Buffer.from(s.startsWith('\\x') ? s.slice(2) : s, 'hex');
}

export async function saveGmailToken(handle: string, t: GmailTokenInput): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('gmail_oauth_tokens').upsert({
        handle,
        refresh_token_enc: bufToHex(t.refreshTokenEnc),
        access_token_enc: t.accessTokenEnc ? bufToHex(t.accessTokenEnc) : null,
        access_token_expiry: t.accessTokenExpiry ?? null,
        scope: t.scope,
        google_email: t.googleEmail ?? null,
        revoked: false,
      }, { onConflict: 'handle' });
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('saveGmailToken', error);
    }
  }
  mem.gmailTokens.set(handle, {
    handle, refreshTokenEnc: t.refreshTokenEnc, accessTokenEnc: t.accessTokenEnc ?? null,
    accessTokenExpiry: t.accessTokenExpiry ?? null, scope: t.scope, googleEmail: t.googleEmail ?? null, revoked: false,
  });
}

export async function getGmailToken(handle: string): Promise<GmailToken | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('gmail_oauth_tokens').select('*').eq('handle', handle).maybeSingle();
      if (error) throw error;
      if (!data || data.revoked) return null;
      return {
        handle: data.handle,
        refreshTokenEnc: hexToBuf(data.refresh_token_enc),
        accessTokenEnc: data.access_token_enc ? hexToBuf(data.access_token_enc) : null,
        accessTokenExpiry: data.access_token_expiry ?? null,
        scope: data.scope,
        googleEmail: data.google_email ?? null,
        revoked: data.revoked ?? false,
      };
    } catch (error) {
      logDbError('getGmailToken', error);
    }
  }
  const t = mem.gmailTokens.get(handle);
  return t && !t.revoked ? t : null;
}

/** List handles with a live (non-revoked) Gmail connection — used by the email poller. */
export async function listConnectedHandles(): Promise<string[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('gmail_oauth_tokens').select('handle').eq('revoked', false);
      if (error) throw error;
      return (data ?? []).map((r: { handle: string }) => r.handle);
    } catch (error) {
      logDbError('listConnectedHandles', error);
    }
  }
  return [...mem.gmailTokens.values()].filter(t => !t.revoked).map(t => t.handle);
}

/** Resolve a handle from the connected Google account's email (for Gmail push -> handle mapping). */
export async function findHandleByGoogleEmail(email: string): Promise<string | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('gmail_oauth_tokens')
        .select('handle').eq('google_email', email).eq('revoked', false).maybeSingle();
      if (error) throw error;
      return data?.handle ?? null;
    } catch (error) {
      logDbError('findHandleByGoogleEmail', error);
    }
  }
  const match = [...mem.gmailTokens.values()].find(t => !t.revoked && t.googleEmail === email);
  return match?.handle ?? null;
}

export async function revokeGmailToken(handle: string): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('gmail_oauth_tokens').update({ revoked: true }).eq('handle', handle);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('revokeGmailToken', error);
    }
  }
  const t = mem.gmailTokens.get(handle);
  if (t) mem.gmailTokens.set(handle, { ...t, revoked: true });
}
