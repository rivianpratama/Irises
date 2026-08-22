// Cron validation for engine-bound schedules. Recurring automations are described by a 5-field
// cron string plus an IANA timezone; cron-parser handles timezone-aware evaluation and DST
// transitions, and its syntax validation doubles as a guard on LLM-produced cron strings.
import parser from 'cron-parser';
import { DEFAULT_TZ } from './zonedTime.js';

/** True if `cron` is a valid expression. Used to reject bad LLM output before scheduling.
 *  The default zone is the resolved DEFAULT_TZ (never a hardcoded city — see zonedTime.ts). */
export function isValidCron(cron: string, timezone = DEFAULT_TZ): boolean {
  try {
    parser.parseExpression(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}
