// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The ASSEMBLY half of associative threading: where the thread block lands in the system prompt, and
// the no-regression pin the whole feature rests on — with nothing to offer, the prompt is byte for
// byte the prompt of an install that never had threading. The sibling of internalWeather.test.ts,
// and deliberately built the same way: buildSystemPrompt is called directly, nothing here reaches a
// lane, a DB, or the selection engine (persona/threads.test.ts owns what gets chosen and why).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type ChatContext } from './shared.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import type { ThreadCandidate, ThreadMaterial } from '../../persona/threads.js';
import type { ThreadTurn } from '../../memory/threadHarvest.js';
import type { StoredMessage } from '../../db/types.js';

const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111' };

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),          // menstrual, day 1
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 2, 0, 0), 'UTC'),        // dead_night
};

function affect(): AffectState {
  const emitted = coerceStatus({
    mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
    anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
    engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
    profile_note: 'warm, forward-looking', terminal_closure: false,
  })!;
  const last = mergeStatus(emitted, COMPUTED, 0);
  return { last, moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] };
}

/** A thread long enough that renderConversationTiming has something to say — the block the thread
 *  block has to sit AHEAD of. */
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'morning', handle: '+15550001111', at: Date.UTC(2026, 0, 5, 9, 0) },
  { role: 'assistant', content: 'morning boss', at: Date.UTC(2026, 0, 5, 9, 1) },
];

const LOOP: ThreadCandidate = {
  material: 'loop', rungCeiling: 'fact', id: 'l1',
  label: 'the interview', note: 'the one around thursday',
};
const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft', note: 'they keep landing back on shipping fast versus doing it right',
};

function build(thread?: ThreadTurn): string {
  return buildSystemPrompt(
    ctx, '', [], undefined, undefined, HISTORY, 'hey', undefined, affect(), COMPUTED, null, undefined, thread,
  );
}

/** internalWeather.test.ts's normalization, verbatim: the assembled prompt carries a clock line with
 *  a millisecond instant AND a minute-resolution local time, so two builds differ there and nowhere
 *  else. Blank the whole clock line plus every ISO instant, and the rest is byte for byte. */
function stable(prompt: string): string {
  return prompt
    .replace(/^Right now it's .*$/m, "Right now it's <now>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<now>');
}

// ── Position ─────────────────────────────────────────────────────────────────

test('an offered thread lands between the internal-weather block and conversation timing', () => {
  const prompt = build({ offer: LOOP, outcomeAsk: null });

  const weather = prompt.indexOf('## Where you are right now (INTERNAL weather');
  const thread = prompt.indexOf('## Something they left open');
  const timing = prompt.indexOf('## Conversation timing');
  assert.ok(weather !== -1, 'the weather block is present');
  assert.ok(thread !== -1, 'the thread block is present');
  assert.ok(timing !== -1, 'the timing block is present');
  assert.ok(weather < thread, 'the thread block follows the weather block');
  assert.ok(thread < timing, 'and precedes the conversation-timing block');

  // Its OWN dyn entry, never folded into the weather block: that block ends on a pinned re-report
  // tail, and one header is the invariant internalWeather.test.ts pins for the climate half too.
  assert.equal(prompt.split('INTERNAL weather').length - 1, 1, 'still exactly one weather header');

  // The model's own words for the thing ride through bare; the machinery never does. Scoped to the
  // block itself — the 120k-char persona above it is full of ordinary English.
  assert.match(prompt, /"the interview": the one around thursday/);
  const block = prompt.slice(thread, timing);
  assert.doesNotMatch(block, /rungCeiling|material|confidence|evidence/i);
  assert.doesNotMatch(block, /\d/, 'the block is numberless — a number is a thing to optimize');
});

test('a theme at the pattern rung renders the offer prose, and no rung word', () => {
  const prompt = build({ offer: THEME, outcomeAsk: null });
  assert.match(prompt, /## A thread you've half-noticed/);
  assert.match(prompt, /"speed vs craft": they keep landing back/);
  assert.match(prompt, /Enter a rung below what you could claim/);
  assert.doesNotMatch(prompt, /## Something they left open/);
});

// ── Byte-inertness, with the negative control that gives it teeth ────────────

test('an empty thread is byte-identical to no thread param at all — and a candidate is NOT', () => {
  const bare = stable(build());
  assert.equal(stable(build(undefined)), bare);
  assert.equal(stable(build({ offer: null, outcomeAsk: null })), bare,
    'nothing qualified this turn must cost the prompt nothing');

  // …and the comparison has teeth in every direction that can render.
  assert.notEqual(stable(build({ offer: LOOP, outcomeAsk: null })), bare);
  assert.notEqual(stable(build({ offer: THEME, outcomeAsk: null })), bare);
  assert.notEqual(stable(build({ offer: null, outcomeAsk: { label: 'speed vs craft', material: 'theme' } })), bare);
});

// ── The outcome ask, alone ───────────────────────────────────────────────────

// The two halves are independent: the turn after an offer is consumed usually has nothing NEW to
// offer (the pending slot blocks selection outright), so the ask standing alone is the common case.
test('an outcome ask with no offer renders just the ask', () => {
  const prompt = build({ offer: null, outcomeAsk: { label: 'speed vs craft', material: 'theme' } });
  assert.match(prompt, /## Last turn you floated a thread — "speed vs craft"/);
  assert.match(prompt, /status\.thread_outcome/);
  assert.match(prompt, /Bookkeeping only — never mention it\./);
  // No offer block came with it.
  assert.doesNotMatch(prompt, /## A thread you've half-noticed/);
  assert.doesNotMatch(prompt, /## Something they left open/);
});

test('the loop flavour of the ask asks about a question, not a tag', () => {
  const material: ThreadMaterial = 'loop';
  const prompt = build({ offer: null, outcomeAsk: { label: 'the interview', material } });
  assert.match(prompt, /## Last turn you asked about something pending — "the interview"/);
  assert.doesNotMatch(prompt, /floated a thread/);
});

// Both halves at once: an offer this turn plus the ask about last turn's. Offer leads (it is this
// turn's live decision); the ask is a footnote.
test('offer and ask can render together, offer first', () => {
  const prompt = build({ offer: THEME, outcomeAsk: { label: 'the interview', material: 'loop' } });
  const offer = prompt.indexOf("## A thread you've half-noticed");
  const ask = prompt.indexOf('## Last turn you asked about something pending');
  assert.ok(offer !== -1 && ask > offer, 'the offer leads and the ask follows');
});
