import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Driver is decided once at startup by presence of Supabase credentials.
// Mirrors the original behavior where missing AWS creds => in-memory fallback.
export type DbDriver = 'supabase' | 'memory';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const forcedBackend = process.env.DATA_BACKEND; // 'supabase' | 'memory' (optional override)

export const driver: DbDriver =
  forcedBackend === 'memory'
    ? 'memory'
    : url && serviceKey
      ? 'supabase'
      : 'memory';

let _client: SupabaseClient | null = null;
if (driver === 'supabase') {
  _client = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  console.log('[db] Using Supabase Postgres backend');
} else {
  console.warn('[db] No Supabase credentials (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Using in-memory backend.');
}

/** Returns the Supabase client, or null when running on the in-memory fallback. */
export function getSupabase(): SupabaseClient | null {
  return _client;
}

// Filled by src/diagnostics/errorLog.ts at module load — one slot instead of touching the
// 110+ logDbError call sites, and no import cycle (this module never imports the sink).
let dbErrorSink: ((scope: string, error: unknown) => void) | null = null;

export function setDbErrorSink(fn: (scope: string, error: unknown) => void): void {
  dbErrorSink = fn;
}

/** Convenience: true when a transient Supabase error should fall back to memory. */
export function logDbError(scope: string, error: unknown): void {
  console.error(`[db] ${scope} failed, falling back to in-memory store.`, error);
  try { dbErrorSink?.(scope, error); } catch { /* never let telemetry break a repository */ }
}
