// Storage driver selection + the shared repository error sink.
//
//   'sqlite' — the default: durable local storage under IRISES_HOME (stateDir.ts).
//              Machine tables live in irises.db (sqlite.ts); the curated memory
//              tiers live as markdown under memories/<handle>/.
//   'memory' — DATA_BACKEND=memory: the SAME code paths against an ephemeral
//              root (SQLite ':memory:' + a throwaway temp dir). Nothing survives
//              the process — tests and zero-residue local runs.
//
// Decided once at first import (tests set DATA_BACKEND before their imports).
export type DbDriver = 'sqlite' | 'memory';

export const driver: DbDriver = process.env.DATA_BACKEND === 'memory' ? 'memory' : 'sqlite';

// Boot visibility: an install upgraded from the Supabase era may still carry
// DATA_BACKEND=memory in its .env — without this line it would run ephemeral
// silently while the docs promise persistence.
if (driver === 'memory') {
  console.warn('[db] DATA_BACKEND=memory — EPHEMERAL storage, nothing persists across restarts. Unset it for the durable local store under IRISES_HOME (default ~/.irises).');
} else {
  console.log('[db] driver: sqlite — durable local store under IRISES_HOME (default ~/.irises)');
}

if (process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[db] Supabase support was removed — SUPABASE_* env vars are ignored. Data lives under IRISES_HOME (default ~/.irises).');
}

// Filled by src/diagnostics/errorLog.ts at module load — one slot instead of touching the
// 110+ logDbError call sites, and no import cycle (this module never imports the sink).
let dbErrorSink: ((scope: string, error: unknown) => void) | null = null;

export function setDbErrorSink(fn: (scope: string, error: unknown) => void): void {
  dbErrorSink = fn;
}

/** Repository error funnel: console + telemetry sink; never throws. */
export function logDbError(scope: string, error: unknown): void {
  console.error(`[db] ${scope} failed.`, error);
  try { dbErrorSink?.(scope, error); } catch { /* never let telemetry break a repository */ }
}
