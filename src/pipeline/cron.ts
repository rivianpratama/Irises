// Cron evaluation for the Autonome scheduler. Recurring automations store a 5-field
// cron string plus an IANA timezone; we compute the next absolute fire time from them.
// cron-parser handles the hard parts: timezone-aware evaluation and DST transitions
// (e.g. "every day at 02:30 America/Chicago" on the spring-forward night), and it
// validates syntax — which doubles as a guard on LLM-produced cron strings.
import parser from 'cron-parser';

/** Next absolute fire time (ISO, UTC) for a cron expression evaluated in an IANA tz. */
export function nextRunAt(cron: string, timezone: string, from: Date = new Date()): string {
  const it = parser.parseExpression(cron, { tz: timezone, currentDate: from });
  return it.next().toDate().toISOString();
}

/** True if `cron` is a valid expression. Used to reject bad LLM output before insert. */
export function isValidCron(cron: string, timezone = 'America/Chicago'): boolean {
  try {
    parser.parseExpression(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}
