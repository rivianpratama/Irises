// buildSystemPrompt injects Irises's hidden "internal weather" (cycle + circadian + carried-forward
// mood + last-turn meta-prompt) only when the computed state is passed. Proves the block appears,
// carries prior mood, and is absent on the legacy (no-affect) call path.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type ChatContext } from './shared.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';

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

test('the internal-weather block is injected when computed state is present', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, undefined, COMPUTED);
  assert.match(prompt, /## Where you are right now \(INTERNAL weather/);
  assert.match(prompt, /never say/i);
  assert.match(prompt, /First read of this person/);       // cold start (no prior status)
});

test('a prior mood + meta-prompt carry forward into the block', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  assert.match(prompt, /hopeful \(joyful, 72\/100\)/);      // carried mood
  assert.match(prompt, /keep it light and follow their lead/); // carried meta-prompt
});

test('no computed state → no internal-weather block (legacy path unchanged)', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined);
  assert.ok(!prompt.includes('INTERNAL weather'));
});
