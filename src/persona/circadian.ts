// Time of day, anchored to THE USER'S timezone (agent_tz), so Irises's daily rhythm tracks the
// person she is actually talking to. Reuses hourInZone() from chatTime.ts (the same zoned-clock
// read the timing block already trusts) so there is one source of truth for "what hour is it for
// them". Ported from Martins-Crib getAliceTimeDemeanor. Never named to the user.
//
// TWO NUMBERS AND A SLOT, and nothing else leaves this file. `energy` feeds the gauge targets
// (persona/affectDrift.ts) and the `slot` answers exactly one question the prompt asks: is it late
// enough where they are that the reply gets smaller (persona/affectCompiler.ts LATE_SLOTS). The
// hour is a register and never a script — it lowers the volume and never picks the content, which
// is why nothing downstream branches on it. The seven paragraphs of per-slot texture that used to
// ride every turn are deleted: a paragraph about the cortisol window told the model how to FEEL and
// left what to DO to be inferred, and inference is what the compiler does now, in one line, from
// the same slot.

import { hourInZone } from '../pipeline/chatTime.js';
import { DEFAULT_TZ } from '../pipeline/zonedTime.js';

export type CircadianSlot =
  | 'dead_night' | 'early_morning' | 'morning_sharp'
  | 'afternoon_dip' | 'afternoon_peak' | 'evening' | 'pre_sleep';

export interface CircadianState {
  slot: CircadianSlot;
  hour: number;        // 0-23 in the user's zone
  weekend: boolean;
  energy: number;      // 1-100: usable social/warmth energy this slot
}

function slotForHour(hour: number): CircadianSlot {
  if (hour < 5) return 'dead_night';
  if (hour < 9) return 'early_morning';
  if (hour < 12) return 'morning_sharp';
  if (hour < 15) return 'afternoon_dip';
  if (hour < 18) return 'afternoon_peak';
  if (hour < 22) return 'evening';
  return 'pre_sleep';
}

const ENERGY: Record<CircadianSlot, number> = {
  dead_night: 30,
  early_morning: 45,
  morning_sharp: 70,
  afternoon_dip: 40,
  afternoon_peak: 90,
  evening: 70,
  pre_sleep: 35,
};

/** Circadian state for the instant, in the user's zone (falls back to DEFAULT_TZ — this host's zone). */
export function computeCircadian(nowMs: number, tz: string = DEFAULT_TZ): CircadianState {
  let hour: number;
  let weekend = false;
  try {
    hour = hourInZone(nowMs, tz);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(nowMs));
    weekend = weekday === 'Saturday' || weekday === 'Sunday';
  } catch {
    hour = new Date(nowMs).getUTCHours();
  }
  const slot = slotForHour(hour);
  return { slot, hour, weekend, energy: ENERGY[slot] };
}
