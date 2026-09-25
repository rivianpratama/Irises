// Storage driver selection + the shared repository error sink.
//
//   'sqlite' — the default: durable local storage under IRISES_HOME (stateDir.ts).
//              Machine tables live in irises.db (sqlite.ts); the curated memory
//              tiers live as markdown under memories/<handle>/.
//   'memory' — DATA_BACKEND=memory: the SAME code paths against an ephemeral
//              root (SQLite ':memory:' + a throwaway temp dir). Nothing survives
//              the process — tests and zero-residue local runs.
//
// Decided once at first import. A test process never gets the durable store unless it says so:
// NODE_TEST_CONTEXT is set by node's runner in every test child (a bare `tsx --test <file>` too),
// and the argv check covers `tsx <file>.test.ts`. The `process.env.DATA_BACKEND = 'memory'` line at
// the top of test files does NOT do this — CJS hoists their requires above it. A test that really
// needs the disk (sqlite.disk.test.ts, stateDir.test.ts) sets DATA_BACKEND=sqlite before a dynamic
// import, and resetStorageForTests still refuses any home outside the OS temp dir.
export type DbDriver = 'sqlite' | 'memory';

const underTest = !!process.env.NODE_TEST_CONTEXT || /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
export const driver: DbDriver =
  process.env.DATA_BACKEND === 'memory' ? 'memory'
  : process.env.DATA_BACKEND === 'sqlite' ? 'sqlite'
  : underTest ? 'memory'
  : 'sqlite';

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
