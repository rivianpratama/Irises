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
