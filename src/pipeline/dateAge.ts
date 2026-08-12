// Date-vs-now phrasing for tool renders, prompts, and pipeline hygiene. All deltas are PRECOMPUTED
// here (never asked of the model) per the chatTime "precomputed — trust this, don't do date math"
// convention. Whole-day granularity; every function takes an explicit nowMs so callers/tests pin it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from an ISO date/instant to now (positive = in the past). null if unparseable. */
export function daysBetween(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

function describeDelta(d: number | null): string | null {
  if (d === null) return null;
  if (d === 0) return 'today';
  return d > 0 ? `${d}d past` : `in ${-d}d`;
}

/** The instant's calendar date ("YYYY-MM-DD") in the given IANA timezone. */
function calendarDateInTz(ms: number, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * A target/due DATE relative to today: "today" | "in 7d" | "25d past". A date-only value
 * ("YYYY-MM-DD") is compared CALENDAR-day to calendar-day; pass `tz` so "today" is the user's local
 * date, not UTC's (a Chicago evening is already the next UTC date, which would shift the delta a day).
 * Falls back to a raw instant diff for a full timestamp or when tz is omitted.
 */
export function describeDateVsToday(iso: string | null | undefined, nowMs: number, tz?: string): string | null {
  if (!iso) return null;
  const target = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return describeDelta(daysBetween(iso, nowMs));
  const today = tz ? calendarDateInTz(nowMs, tz) : new Date(nowMs).toISOString().slice(0, 10);
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)) / DAY_MS);
  return describeDelta(d);
}

/** An activity TIMESTAMP as staleness: "today" | "31d ago". null if unparseable/absent. */
export function describeAgeDays(iso: string | null | undefined, nowMs: number): string | null {
  const d = daysBetween(iso, nowMs);
  if (d === null) return null;
  return d <= 0 ? 'today' : `${d}d ago`;
}

/** Whole days a deadline is overdue (dueAt strictly before now), else null (future/undated). */
export function overdueDays(iso: string | null | undefined, nowMs: number): number | null {
  const d = daysBetween(iso, nowMs);
  return d != null && d > 0 ? d : null;
}
