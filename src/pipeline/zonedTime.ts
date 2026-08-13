// Timezone-aware wall-clock → UTC conversion for deadline-derived scheduling.
// LLM extraction gives us a calendar date (YYYY-MM-DD) and we anchor a fixed
// wall-clock time (e.g. 5pm) to it. Naively doing `Date.parse(`${date}T17:00:00`)`
// parses in the HOST's local timezone, so on a UTC-deployed server "5pm" becomes
// 17:00 UTC (~noon in America/Chicago) and every derived reminder fires hours off.
//
// This computes the correct UTC instant for a wall-clock time in a real IANA zone,
// handling DST, using Intl.DateTimeFormat offset arithmetic (no extra dependency) —
// the same tz-aware approach already used by cron.ts and the quiet-hours rule.

/** Default IANA timezone for scheduling until a per-agent tz is stored (mirrors the runner/convo client). */
export const DEFAULT_TZ = 'America/Chicago';

/**
 * Quiet hours = 9pm–8am in the given IANA zone. The single definition shared by the
 * runner (which defers respect_quiet_hours automations) and the email Judge (which decides
 * whether to hold a non-urgent flag to morning) — so the two can never silently diverge.
 */
export function inQuietHours(timeZone: string = DEFAULT_TZ): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(new Date()));
    return hour >= 21 || hour < 8;
  } catch {
    return false;
  }
}

/**
 * Offset (ms, positive = ahead of UTC) of `timeZone` at the given UTC instant.
 * Renders the instant in the zone, reinterprets that wall clock as if it were UTC,
 * and takes the difference — which is the zone's offset at that instant (DST-aware).
 */
function tzOffsetMs(timeZone: string, instant: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23', // avoids the "24" some engines emit for midnight under hour12:false
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(instant))) {
    if (p.type !== 'literal') f[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUTC - instant;
}

/**
 * Convert wall-clock components interpreted in `timeZone` to a UTC epoch (ms), DST-correct.
 * Assumes the components form a valid date (callers should validate strings first).
 */
export function zonedTimeToUtcMs(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): number {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  // Treat the wall clock as if it were UTC, then subtract the zone's offset. The
  // offset itself depends on the instant, so refine once using the corrected guess —
  // this resolves DST transitions correctly.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const o1 = tzOffsetMs(timeZone, guess);
  const o2 = tzOffsetMs(timeZone, guess - o1);
  return guess - o2;
}

/**
 * Parse a `YYYY-MM-DD` date plus a wall-clock time-of-day in `timeZone` into a UTC epoch (ms).
 * Drop-in replacement for `Date.parse(`${date}T${hh}:${mm}:${ss}`)` but anchored to a real
 * timezone instead of the host's. Returns NaN for a malformed or non-existent calendar date
 * (e.g. '2026-02-30'), matching the prior behavior callers already guard against.
 */
export function dateTimeInZone(
  dateYmd: string,
  time: { hour: number; minute?: number; second?: number },
  timeZone: string = DEFAULT_TZ,
): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible dates that Date.UTC would silently roll over (e.g. Feb 30 → Mar 2).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return NaN;
  }
  return zonedTimeToUtcMs({ year, month, day, hour: time.hour, minute: time.minute, second: time.second }, timeZone);
}
