// Engine session ROTATION. Nothing here talks to an engine — it only decides what a session is
// called right now, so the adapters (hermesBackend, and openclawBackend if it ever wants it) can
// share one window arithmetic.
//
// Why rotate at all: Irises threaded ONE engine session per chat forever, and an engine session is a
// transcript. The failing VPS run's session held 398 messages and spent ≈221,760 input tokens per
// API call — a flash-tier model reasoning inside a near-full context, which is what plausibly cost
// it its tool choice ("Repaired 6 message-alternation violations" in the engine's own log). The
// engine's DURABLE user memory does not live in the transcript: hermes keeps it under
// ~/.hermes/memories, while transcripts are rows in ~/.hermes/state.db (`sessions`, keyed by the
// session id we send, plus their `messages`). So starting a fresh transcript each window drops the
// bloat and leaves the engine's model of the user exactly where it is — and the memory KEY keeps
// going out unrotated, so a build that namespaces memory by that key keeps its scope too. That
// split is the whole design: the adapter rotates its continuity id and never its memory key.
//
// Only the hermes adapter rotates today (env HERMES_SESSION_ROTATION). OpenClaw's `openclawSessionKey`
// is ONE string used as both continuity and memory scope on the Gateway `agent` RPC, so rotating it
// there would drop the engine's user model along with the transcript — the opposite of the point.
// Splitting that needs a second key OpenClaw's RPC does not have.

import { isoWeekParts } from '../../pipeline/isoWeek.js';

/** The rotation windows, single-source (the THEME_KINDS pattern) → the type is derived from it. */
export const SESSION_ROTATIONS = ['never', 'weekly', 'daily'] as const;
export type SessionRotation = (typeof SESSION_ROTATIONS)[number];

/** Weekly: long enough that a week's chat keeps its continuity, short enough that a transcript
 *  cannot grow to the size that starved the failing run. `never` is the byte-identical off path. */
export const DEFAULT_SESSION_ROTATION: SessionRotation = 'weekly';

/**
 * ISO-8601 week of a UTC instant as `<week-numbering-year>-<2-digit week>`.
 *
 * The arithmetic itself is `isoWeekParts` in `src/pipeline/isoWeek.ts` — the repo's one home for it,
 * shared with the thread-ping dedupe key, which renders the same parts as `2026-W36`. Only the
 * rendering is local: two-digit padding so the suffix has one fixed width all year (matching the
 * repo's other ISO-week rendering). The week-numbering year is NOT the calendar year: 2026 has 53
 * ISO weeks, so 2027-01-01..03 belong to `2026-53`, and a calendar-year suffix would have rotated a
 * session mid-week, on a Friday.
 */
function isoWeekToken(nowMs: number): string {
  const { year, week } = isoWeekParts(nowMs);
  return `${year}-${String(week).padStart(2, '0')}`;
}

/** `YYYYMMDD` of a UTC instant. */
function dayToken(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The window token a policy appends — `''` for `never`, `-w<iso-year>-<iso-week>`, `-d<YYYYMMDD>`.
 * UTC on purpose: the boundary must be the same instant for every deployment, and a session id that
 * moved with the host's zone would rotate twice (or not at all) around a zone change. At most 10
 * characters, so a rotated id stays far inside the engines' header/key limits.
 */
function windowToken(nowMs: number, policy: SessionRotation): string {
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
  return `${baseId}${windowToken(nowMs, policy)}`;
}

/**
 * Parse a rotation policy out of a raw env value. Reading shape borrowed from `threadingEnabled()`
 * (`src/db/repositories/threadInventory.ts`): trimmed, lower-cased, empty means the default.
 *
 * The FALLBACK direction is deliberately the opposite of that sibling's, so do not read the two as
 * the same rule: `threadingEnabled` maps an unrecognized value to OFF, while an unrecognized value
 * here also means the DEFAULT (`weekly`). A typo (`HERMES_SESSION_ROTATION=week`) must not silently
 * switch the rotation off — that is the one failure mode nobody would see. What an operator loses
 * instead is the value they typed, so the env boundary announces the miss: `unknownSessionRotation`
 * below, warned about in `hermesSessionRotation()`.
 *
 * Pure — the env read itself lives beside its sibling engine env reads in the adapter.
 */
export function parseSessionRotation(raw: string | undefined): SessionRotation {
  const v = (raw || '').trim().toLowerCase();
  return (SESSION_ROTATIONS as readonly string[]).includes(v) ? (v as SessionRotation) : DEFAULT_SESSION_ROTATION;
}

/**
 * The value `raw` tried and failed to name, or `null` when it named a window — i.e. exactly the
 * cases `parseSessionRotation` sends to the default without being asked to. Split out so the parse
 * stays pure and the WARNING lives at the env boundary, the way the `unknown OPS_BACKEND "…"` line
 * does for the sibling engine flag (`engineBackend.ts`).
 *
 * Empty/unset is NOT a miss: it means the default on purpose. The offending value comes back as
 * written (trimmed only), so the warning can quote it back to whoever typed it.
 */
export function unknownSessionRotation(raw: string | undefined): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  return (SESSION_ROTATIONS as readonly string[]).includes(v.toLowerCase()) ? null : v;
}
