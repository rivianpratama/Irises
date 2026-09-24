// The early-emit gate: streamArmed (whole-turn), sentenceBlocker (per-sentence) and
// cleanEarlySentence (the shared cosmetic cleanup). All three are pure, so these tests never touch
// the model, the DB or the clock.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamArmed, sentenceBlocker, cleanEarlySentence, type PreCallFacts } from './earlyEmit.js';

const CLEAN: PreCallFacts = {
  hasParkedApproval: false,
  hookMode: 'task',
  groundingFlagged: false,
  isGroupChat: false,
  introOrFirstMove: false,
  isBurst: false,
  enabled: true,
};

test('streamArmed: true when every fact is clean', () => {
  assert.equal(streamArmed(CLEAN), true);
});

test('streamArmed: an undefined hookMode reads the same as a task turn', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: undefined }), true);
});

test('streamArmed: a share turn arms — the share law is enforced in the prompt, not by a rewrite', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'share' }), true);
});

test('streamArmed: a hook (idle-turn) mode arms — same reason, the hook law is enforced in the prompt', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'hook' }), true);
});

test('streamArmed: a quiet turn never arms — enforceQuiet can still rewrite the draft after generation', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'quiet' }), false);
});

test('streamArmed: each other fact flips it false on its own', () => {
  assert.equal(streamArmed({ ...CLEAN, hasParkedApproval: true }), false, 'parked approval');
  assert.equal(streamArmed({ ...CLEAN, groundingFlagged: true }), false, 'grounding flagged');
  assert.equal(streamArmed({ ...CLEAN, isGroupChat: true }), false, 'group chat');
  assert.equal(streamArmed({ ...CLEAN, introOrFirstMove: true }), false, 'intro / first move');
  assert.equal(streamArmed({ ...CLEAN, isBurst: true }), false, 'burst — bubble 0\'s thread target is unknown');
  assert.equal(streamArmed({ ...CLEAN, enabled: false }), false, 'STREAM_FIRST_BUBBLE off');
});

test('sentenceBlocker: an unkept promise', () => {
  assert.equal(sentenceBlocker('ok, lemme check that', 'whats the latest node LTS'), 'promise');
});

test('sentenceBlocker: an unbacked claim', () => {
  assert.equal(sentenceBlocker('got it, revised the morning one', 'can you move it earlier'), 'claim');
});

test('sentenceBlocker: a clean sentence carrying no failure shape', () => {
  assert.equal(sentenceBlocker('408', 'whats 17% of 2400'), null);
});

test('sentenceBlocker: a capability refusal (routingGate.test.ts fixture)', () => {
  assert.equal(sentenceBlocker("i can't browse the web from here", 'whats the latest node LTS'), 'refusal');
});

test('sentenceBlocker: raw Ops scaffolding reads as an internal leak', () => {
  assert.equal(sentenceBlocker('ANSWER: yes', 'is the store open'), 'internal');
});

test('cleanEarlySentence: strips a leaked reply-routing tag', () => {
  assert.equal(cleanEarlySentence('[[re:2]]yes'), 'yes');
});
