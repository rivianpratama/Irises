// Trace labels, and nothing else. NO IMPORTS — that is the whole point of the file.
//
// A trace label is a string two very different kinds of code have to agree on: the subsystem that
// records the event, and whatever later reads the stream back (the dashboard, a convergence battery
// picking its receipts out of `diagnostic_turn_history` with SQL). The reader is usually the one
// that cannot afford the recorder's dependencies: `diagnostics/turnTrace.ts` imports `record`, which
// imports the turn store and two db repositories, so a battery that only wanted to know which string
// to match on used to open a SQLite connection and print the driver banner to do it. The label is
// one word; it should not cost a database.
//
// So labels that more than one layer needs live here, where importing one drags nothing behind it,
// and the module that records the event re-exports its own (`turnTrace.ts` does). A label that is
// still a literal at its `record` call — `threads:select` in memory/threadHarvest.ts — belongs here
// the day something outside that module needs to name it.

/** The `turn:trace` label — one receipt per user-visible turn (diagnostics/turnTrace.ts). */
export const TURN_TRACE_LABEL = 'turn:trace';

// ── the rhythm engine's five ─────────────────────────────────────────────────
//
// That day arrived for these: the hook battery (scripts/convergence/hookBattery.ts) picks all five
// out of `diagnostic_turn_history` with SQL and out of the trace ring over HTTP, and it scores the
// idle gate, the kill switch and the moment spacing off nothing else. A battery that retyped them
// would score an empty round as clean the first time one was renamed, which is the exact failure
// this file was built to prevent.

/** The idle gate's own reading, filed on EVERY turn the rhythm selector ran — a healthy no-op
 *  included (agents/convo/client.ts). Carries which layer decided and which reason won. */
export const HOOKS_SELECT_LABEL = 'hooks:select';

/** Layer 3 of the idle gate: one receipt per reading, cache hit or lane call
 *  (agents/convo/idleClassify.ts). */
export const IDLE_CLASSIFY_LABEL = 'idle:classify';

/** The forced-quiet backstop's evaluation, filed whether or not the quiet was broken
 *  (agents/convo/shared.ts `enforceQuiet`). The healthy no-op is what makes the kill switch
 *  scorable at all. */
export const QUIET_GUARD_LABEL = 'convo:quiet_guard';

/** A hook word that rode a TASK turn: counted and receipted, never re-asked
 *  (agents/convo/shared.ts). */
export const HOOK_OFF_TURN_LABEL = 'hook:off_turn';

/** The moment sampler's bill — how many episodes were put in front of her, how many rendered, how
 *  many the 24-hour window held out (agents/convo/client.ts). */
export const MOMENTS_OFFER_LABEL = 'moments:offer';
