// Capability-aware delegation: renderCapabilityLine turns the engine's closed-vocabulary capability
// summary into one brand-free per-turn line, and buildSystemPrompt injects it right after the tool
// docs. A missing high-value class (inbox) adds an explicit guard; a null summary injects NOTHING and
// leaves the persona head byte-identical (the static Context.md doctrine stands).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, renderCapabilityLine, convoPersonaChars, type ChatContext } from './shared.js';
import type { CapabilitySummary } from '../ops/engineBackend.js';

const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111' };

// buildSystemPrompt(chatContext, contextBlock, activeOps, extraSection, tools, history, incomingText,
//   agentTz, affectState, computed, capabilitySummary) — capabilitySummary is the last param.
function build(summary: CapabilitySummary | null | undefined): string {
  return buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, undefined, undefined, summary);
}

test('renderCapabilityLine: with inbox present, names the inbox look and adds NO not-connected guard', () => {
  const line = renderCapabilityLine({ classes: ['web', 'inbox', 'files'] });
  assert.ok(line, 'a non-empty line is produced');
  assert.match(line, /look through their inbox/);
  assert.match(line, /Your deep look can right now:/);
  assert.ok(!line.includes("inbox isn't connected"), 'no guard when inbox IS available');
});

test('renderCapabilityLine: without inbox, adds the explicit "inbox isn\'t connected" guard', () => {
  const line = renderCapabilityLine({ classes: ['web', 'files', 'code'] });
  assert.ok(line);
  assert.match(line, /inbox isn't connected right now/);
  assert.match(line, /never promise an email look/);
});

test('renderCapabilityLine: null summary and an empty class set both render nothing', () => {
  assert.equal(renderCapabilityLine(null), '');
  assert.equal(renderCapabilityLine({ classes: [] }), '');
});

test('renderCapabilityLine: stays brand-free — never names an engine, tool, or manifest', () => {
  const line = renderCapabilityLine({ classes: ['web', 'inbox', 'files', 'code', 'media', 'scheduling'] });
  assert.doesNotMatch(line, /hermes|openclaw|engine|toolset|manifest|capabilit/i);
});

test('buildSystemPrompt: a summary WITH inbox injects the capability line mentioning the inbox look', () => {
  const prompt = build({ classes: ['web', 'inbox', 'files'] });
  assert.match(prompt, /Your deep look can right now:/);
  assert.match(prompt, /look through their inbox/);
  assert.ok(!prompt.includes("inbox isn't connected"));
});

test('buildSystemPrompt: a summary WITHOUT inbox injects the line WITH the not-connected guard', () => {
  const prompt = build({ classes: ['web', 'files'] });
  assert.match(prompt, /Your deep look can right now:/);
  assert.match(prompt, /inbox isn't connected right now, so never promise an email look/);
});

test('buildSystemPrompt: a null summary adds NO capability line and leaves the persona head unchanged', () => {
  const withNull = build(null);
  const withSummary = build({ classes: ['web', 'inbox'] });
  assert.ok(!withNull.includes('Your deep look can right now'), 'no capability line on the null path');
  // The persona is the cache-stable HEAD of the prompt; the injection lives inside <prompt>, AFTER
  // it, so the persona prefix must be byte-identical whether or not a summary is passed.
  const personaLen = convoPersonaChars();
  assert.equal(withNull.slice(0, personaLen), withSummary.slice(0, personaLen), 'persona head is byte-identical');
});
