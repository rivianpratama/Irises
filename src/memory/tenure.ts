// How long you have known them — the coarse relationship clock, in the two forms the prompt wants
// it: the plain "## How long you've known them" section the context block has always led with, and
// the one line the identity card carries (memory/wrappers.ts).
//
// It lives here rather than in dossier.ts because the identity card needs it and dossier.ts already
// imports the wrappers; a module of its own is the only direction that does not close a cycle.
// `formatDaySpan` is re-exported from dossier.ts so its historical import path still resolves
// (memory/climateDrift.ts, memory/dossier.test.ts) — the same pattern dossier.ts already uses.

import type { UserProfile } from '../db/types.js';

/**
 * The coarse day → week → month → year ladder, with no "ago" on it. THE one place this arithmetic
 * lives: formatAgo below wears it as "~3 weeks ago", and the climate eval's tenure label wears the
 * same string as "you have known this person: ~3 weeks" (climateDrift.ts). They were two copies and
 * they carried the same bug — `Math.floor(days / 365)` reads 0 for days 360-364, which the month
 * branch has already stopped covering, so a year-old relationship rendered "~0 years". The years
 * branch is only ever reached past 360 days, so its smallest honest answer is one.
 *
 * `days` is whole days elapsed, >= 0. Pure.
 */
export function formatDaySpan(days: number): string {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  const wk = Math.floor(days / 7);
  if (wk < 5) return `~${wk} week${wk === 1 ? '' : 's'}`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `~${mo} month${mo === 1 ? '' : 's'}`;
  const yr = Math.max(1, Math.floor(days / 365));
  return `~${yr} year${yr === 1 ? '' : 's'}`;
}

/** Coarse "how long ago" from an epoch-SECONDS timestamp, for relationship warmth (not facts).
 *  `nowMs` is injected so both renderers below are pure. */
export function formatAgo(epochSeconds: number | undefined, nowMs: number): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  const sec = Math.floor(nowMs / 1000) - epochSeconds;
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  return `${formatDaySpan(day)} ago`;
}

/** "first seen ~9 months ago; last seen 20 minutes ago" — null when we have no first-contact stamp.
 *  "last seen" only appears when it is meaningfully more recent than first contact (> ~1 day), and
 *  it tracks the last time we SAVED something about them, so it stays soft context. */
function tenureClause(profile: UserProfile | null, nowMs: number): string | null {
  if (!profile) return null;
  const first = formatAgo(profile.firstSeen, nowMs);
  if (!first) return null;
  const last = formatAgo(profile.lastSeen, nowMs);
  const showLast = last && profile.lastSeen - profile.firstSeen > 86400;
  return showLast ? `first seen ${first}; last seen ${last}` : `first seen ${first}`;
}

/**
 * Convo-only: the plain section the context block leads with on the pre-card path — how long
 * you've known them (tenure) and roughly when you last saw them, so the front line can treat a
 * long-time contact like a regular and welcome a brand-new one lightly. NOT injected into the
 * other agents. '' when there is no first-contact stamp.
 */
export function renderTenureBlock(profile: UserProfile | null, nowMs: number): string {
  const clause = tenureClause(profile, nowMs);
  if (!clause) return '';
  const sentence = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
  return `## How long you've known them\n${sentence}\nThis is soft context for warmth only — a long-time contact is a regular, a brand-new one gets a lighter touch. Don't recite these dates back to them.`;
}

/** The same clock as ONE line, for the identity card: the caveat that used to take two lines of its
 *  own is folded into it, because the card is already the block that says what memory may do. */
export function renderTenureLine(profile: UserProfile | null, nowMs: number): string {
  const clause = tenureClause(profile, nowMs);
  if (!clause) return '';
  return `How long you've known them: ${clause} — soft context for warmth, never recited back to them.`;
}
