// Engine session ROTATION. Nothing here talks to an engine — it only decides what a session is
// called right now, so the adapters (hermesBackend, and openclawBackend if it ever wants it) can
// share one window arithmetic.
//
// Why rotate at all: Irises threaded ONE engine session per chat forever, and an engine session is a
// transcript. The failing VPS run's session held 398 messages and spent ≈221,760 input tokens per
// API call — a flash-tier model reasoning inside a near-full context, which is what plausibly cost
// it its tool choice ("Repaired 6 message-alternation violations" in the engine's own log). The
// engine's DURABLE user memory is a separate store (hermes keeps it under ~/.hermes/memories and
// scopes it by the memory KEY, not by the transcript), so starting a fresh transcript each window
// drops the bloat and keeps the engine's model of the user. That split is the whole design: the
// adapter rotates its continuity id and leaves its memory key alone.
//
// Only the hermes adapter rotates today (env HERMES_SESSION_ROTATION). OpenClaw's `openclawSessionKey`
// is ONE string used as both continuity and memory scope on the Gateway `agent` RPC, so rotating it
// there would drop the engine's user model along with the transcript — the opposite of the point.
// Splitting that needs a second key OpenClaw's RPC does not have.

/** The rotation windows, single-source (the THEME_KINDS pattern) → the type is derived from it. */
export const SESSION_ROTATIONS = ['never', 'weekly', 'daily'] as const;
export type SessionRotation = (typeof SESSION_ROTATIONS)[number];

/** Weekly: long enough that a week's chat keeps its continuity, short enough that a transcript
 *  cannot grow to the size that starved the failing run. `never` is the byte-identical off path. */
export const DEFAULT_SESSION_ROTATION: SessionRotation = 'weekly';

const DAY_MS = 86_400_000;

/**
 * ISO-8601 week of a UTC instant as `<week-numbering-year>-<2-digit week>`.
 *
 * The week-numbering year is NOT the calendar year: 2026 has 53 ISO weeks, so 2027-01-01..03 belong
 * to `2026-53` and a calendar-year suffix would have rotated the session mid-week, on a Friday.
 * Deliberately a local twin of `isoWeek` in `src/memory/threadPings.ts` (same Monday-based, Thursday-
 * owns-the-year arithmetic, same two-digit padding) rather than a shared import: that module pulls
 * the proactive pipeline in behind it, which has no business inside an engine adapter.
 */
function isoWeekToken(nowMs: number): string {
  const d = new Date(nowMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const mondayIndex = (new Date(midnight).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thursday = midnight + (3 - mondayIndex) * DAY_MS;       // the week's Thursday owns its year
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);                            // always in ISO week 1
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.round((thursday - week1Monday) / (7 * DAY_MS)) + 1;
  return `${year}-${String(week).padStart(2, '0')}`;
}

/** `YYYYMMDD` of a UTC instant. */
function dayToken(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The window token a policy appends — `''` for `never`, `-w<iso-year>-<iso-week>`, `-d<YYYYMMDD>`.
 * UTC on purpose: the boundary must be the same instant for every deployment, and a session id that
 * moved with the host's zone would rotate twice (or not at all) around a zone change. Exported for
 * the receipt/tests; `engineSessionId` is what callers want.
 */
export function sessionWindow(nowMs: number, policy: SessionRotation): string {
  if (policy === 'weekly') return `-w${isoWeekToken(nowMs)}`;
  if (policy === 'daily') return `-d${dayToken(nowMs)}`;
  return '';
}

/**
 * The session id an engine call should carry NOW: the adapter's own stable per-chat key plus the
 * current window.
 *
 * `baseId` is that key already built (`hermesSessionKey(chatId)` / `openclawSessionKey(chatId)`) —
 * not a chat id, because the two adapters shape their keys differently (`irises-x` vs
 * `agent:main:irises-x`) and this module must not know either shape. Keeping the key as the id's
 * HEAD is what keeps a rotated session attributable to its chat in the engine's own logs.
 *
 * Pure: `now` is injected, and `never` returns `baseId` unchanged (byte-identical to the pre-rotation
 * id, so the off path is a no-op rather than a differently-computed same-looking string).
 */
export function engineSessionId(baseId: string, nowMs: number, policy: SessionRotation): string {
  return `${baseId}${sessionWindow(nowMs, policy)}`;
}

/**
 * Parse a rotation policy out of a raw env value. Same parse shape as `threadingEnabled()`
 * (`src/db/repositories/threadInventory.ts`): trimmed, lower-cased, empty means the default. An
 * unrecognized value ALSO means the default — a typo (`HERMES_SESSION_ROTATION=week`) must not
 * silently switch the rotation off, which is the one failure mode that would be invisible.
 * Pure — the env read itself lives beside its sibling engine env reads in the adapter.
 */
export function parseSessionRotation(raw: string | undefined): SessionRotation {
  const v = (raw || '').trim().toLowerCase();
  return (SESSION_ROTATIONS as readonly string[]).includes(v) ? (v as SessionRotation) : DEFAULT_SESSION_ROTATION;
}
