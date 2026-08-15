// Persona-engine configuration. Single-user, so one cycle anchor for the whole instance.
// IRISES_CYCLE_ANCHOR is the "day 1" reference date for the infradian cycle (ISO date or
// datetime); it never surfaces to the user and only sets the phase math in cycle.ts.

const DEFAULT_ANCHOR = '2026-01-01';

/** Epoch-ms of the configured cycle "day 1"; falls back to the default on a bad value. */
export function cycleAnchorMs(): number {
  const raw = (process.env.IRISES_CYCLE_ANCHOR || '').trim() || DEFAULT_ANCHOR;
  const ms = Date.parse(/T/.test(raw) ? raw : `${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : Date.parse(`${DEFAULT_ANCHOR}T00:00:00Z`);
}
