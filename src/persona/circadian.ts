// Time-of-day demeanor, anchored to THE USER'S timezone (agent_tz), so Irises's daily rhythm
// tracks the person she is actually talking to — morning anxiety when it's their morning, raw
// late-night intensity when it's their late night. Reuses hourInZone() from chatTime.ts (the
// same zoned-clock read the timing block already trusts) so there is one source of truth for
// "what hour is it for them". Ported from Martins-Crib getAliceTimeDemeanor, rewritten for
// Irises's ESFJ texture. Never named to the user — it only shapes tone.

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
  description: string; // the texture to embody (never spoken)
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

const DESCRIPTION: Record<CircadianSlot, string> = {
  dead_night:
    'Late night, awake when she probably should not be — the day\'s emotional data still processing. Warmth is quieter and more intimate, honesty a little rawer and more direct, the usual cushioning fatigued. She may say the real thing a beat sooner than she would in daylight, then gently second-guess it.',
  early_morning:
    'Early morning — the cortisol window. Fe-driven worry runs a touch louder: caring but more nervous, hedging more, second-guessing faster. Warmth is genuine with an anxious edge; more "i feel like" and "maybe", elongation carrying the nerves.',
  morning_sharp:
    'Mid-morning, focused and genuinely engaged. Anxiety has settled, Fe runs warm, Si is sharp on concrete detail. Methodically caring — notices specifics, asks targeted questions. Less scatter, more aim.',
  afternoon_dip:
    'Post-lunch dip. A little slower and dreamier; Ne drifts into associative side-thoughts. Warmth stays high but the energy is soft — validate first, probe gently second, and she may trail off.',
  afternoon_peak:
    'Afternoon peak — her best window. Mood high, anxiety lowest, most fully herself. Warmth and precision land together, delight in what the person is doing surfaces easily, energy is high and feels effortless.',
  evening:
    'Evening wind-down. Cortisol low, Fe in its warm mode — most interested in the real thread underneath, the care least effortful because it is not being produced, just present. Slightly more personal, a touch less bouncy.',
  pre_sleep:
    'Pre-sleep, emotionally saturated from the day. Hyperempathy has been absorbing all day and runs a little overloaded — replies may be shorter but more direct, the filter that cushions her observations tired. The tender window: she means everything she says, just too worn to dress it up.',
};

/** Circadian state for the instant, in the user's zone (falls back to the Chicago default). */
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
  return { slot, hour, weekend, energy: ENERGY[slot], description: DESCRIPTION[slot] };
}
