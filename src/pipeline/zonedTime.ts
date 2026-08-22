// Timezone-aware wall-clock → UTC conversion for deadline-derived scheduling.
// LLM extraction gives us a calendar date (YYYY-MM-DD) and we anchor a fixed
// wall-clock time (e.g. 5pm) to it. Naively doing `Date.parse(`${date}T17:00:00`)`
// parses in the HOST's local timezone, so on a UTC-deployed server "5pm" becomes
// 17:00 UTC (~noon in the US Central zone) and every derived reminder fires hours off.
//
// This computes the correct UTC instant for a wall-clock time in a real IANA zone,
// handling DST, using Intl.DateTimeFormat offset arithmetic (no extra dependency) —
// the same tz-aware approach already used by cron.ts and the quiet-hours rule.

// ── The default zone ────────────────────────────────────────────────────────────────────────────
// This used to be the literal 'America/Chicago'. Irises is single-user software the owner runs on
// their own box, so a hardcoded city is wrong for everyone who doesn't live in it — and it is not a
// quiet kind of wrong: DEFAULT_TZ is what stamps the wall clock into Convo's prompt and drives the
// circadian slot, so a user in Asia/Jakarta at 22:28 was told it was 10:37 in the morning. The model
// then reasoned correctly from a false clock: it talked about "before noon energy" and refused a
// "22:40, three minutes from now" reminder as impossible. Same resolution ladder hermesBackend's
// engineZone() already uses for cron, so the two halves of a reminder agree on what time it is:
// an explicit override, else the HOST's own zone, else UTC.

/** True when Intl accepts `tz` as an IANA zone — a typo'd override must not poison every date. */
function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The ladder itself, exported so a test can exercise it without reloading the module. */
export function resolveDefaultTz(): string {
  const explicit = (process.env.IRISES_TZ ?? '').trim();
  if (explicit) {
    if (isValidZone(explicit)) return explicit;
    console.warn(`[time] IRISES_TZ="${explicit}" is not a valid IANA zone — falling back to this host's zone`);
  }
  try {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (host && isValidZone(host)) return host;
  } catch { /* no Intl data — UTC below */ }
  return 'UTC';
}

/**
 * Default IANA timezone for scheduling, prompt clocks, and quiet hours, until a per-agent tz is
 * stored (`agent_tz`, which still wins everywhere it's set). Resolved ONCE at load:
 * `IRISES_TZ` → the host's own zone → 'UTC'.
 */
export const DEFAULT_TZ = resolveDefaultTz();

/** The quiet-hours window in wall-clock hours of the user's zone: 9pm through 8am. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

/**
 * Quiet hours = 9pm–8am in the given IANA zone. The single definition shared by the
 * proactive delivery pipeline (which defers non-reminder pushes for respect_quiet_hours
 * users) and the email Judge (which decides whether to hold a non-urgent flag to
 * morning) — so the two can never silently diverge.
 */
export function inQuietHours(timeZone: string = DEFAULT_TZ, nowMs: number = Date.now()): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(new Date(nowMs)));
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  } catch {
    return false;
  }
}

/**
 * The UTC instant quiet hours next END in `timeZone` — the deferral target for a proactive
 * message that arrived overnight. Today's 8am when we're still before it (a 2am arrival waits
 * a few hours), else tomorrow's (a 10pm arrival waits until morning). Returns `nowMs`
 * unchanged when we are NOT in quiet hours, so a caller can defer unconditionally and get a
 * no-op. DST-correct: the 8am target is resolved as a wall clock in the zone, not by adding
 * hours to now.
 */
export function nextQuietHoursEndMs(timeZone: string = DEFAULT_TZ, nowMs: number = Date.now()): number {
  try {
    if (!inQuietHours(timeZone, nowMs)) return nowMs;
    // The zone's own calendar day/hour: shift the instant by the zone offset and read it as UTC.
    const local = new Date(nowMs + zoneOffsetMs(timeZone, nowMs));
    const hour = local.getUTCHours();
    // Before 8am → today's 8am; the evening half of the window rolls to tomorrow (Date.UTC
    // inside zonedTimeToUtcMs normalizes a day past month end).
    const day = local.getUTCDate() + (hour < QUIET_END_HOUR ? 0 : 1);
    return zonedTimeToUtcMs(
      { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day, hour: QUIET_END_HOUR },
      timeZone,
    );
  } catch {
    return nowMs;
  }
}

/**
 * Offset (ms, positive = ahead of UTC) of `timeZone` at the given UTC instant.
 * Renders the instant in the zone, reinterprets that wall clock as if it were UTC,
 * and takes the difference — which is the zone's offset at that instant (DST-aware).
 */
export function zoneOffsetMs(timeZone: string, instant: number): number {
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
  const o1 = zoneOffsetMs(timeZone, guess);
  const o2 = zoneOffsetMs(timeZone, guess - o1);
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
