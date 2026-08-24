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

test('renderCapabilityLine: an INCOMPLETE manifest keeps the prohibition but drops the claim', () => {
  // The adapter understood some tokens and not others, so a missing class is a gap in the map, not a
  // fact about the deployment. Telling someone their inbox isn't connected on that basis is a lie
  // Irises has no way to walk back.
  const line = renderCapabilityLine({ classes: ['web', 'files'], complete: false });
  assert.match(line, /never promise/, 'the guard still fires — this is the safety half');
  assert.ok(!line.includes("inbox isn't connected"), 'but it asserts nothing about their account');
  // A complete summary keeps the stronger wording.
  assert.match(renderCapabilityLine({ classes: ['web', 'files'], complete: true }), /inbox isn't connected right now/);
});

// ── The named-path regression (2026-08-23, E2E retest) ──────────────────────────────────────────
// The files phrase used to read "read files they SHARE" — a promise about what the user hands over
// and nothing about a path they type. Handed "what's in ~/.hermes/skills?", the model read its own
// injected capability line as covering neither, and refused ("that path is local to your machine")
// while the engine sat on that very machine with the file tools. The line has to name both.
test('renderCapabilityLine: the files phrase covers a path they NAME, not just a file they send', () => {
  const line = renderCapabilityLine({ classes: ['files'] });
  assert.match(line, /read files they share or any file or folder path they name/);
  // Still brand-free, and still Irises's own reach — no engine or filesystem jargon leaked in.
  assert.doesNotMatch(line, /hermes|openclaw|engine|tool|manifest|filesystem/i);
});

test('renderCapabilityLine: null summary and an empty class set both render nothing', () => {
  assert.equal(renderCapabilityLine(null), '');
  assert.equal(renderCapabilityLine({ classes: [] }), '');
});

test('renderCapabilityLine: stays brand-free — never names an engine, tool, or manifest', () => {
  const line = renderCapabilityLine({ classes: ['web', 'inbox', 'files', 'code', 'media', 'scheduling'] });
  assert.doesNotMatch(line, /hermes|openclaw|engine|toolset|manifest|capabilit/i);
  // …including on the incomplete-manifest branch, which is the one a live engine actually hits.
  assert.doesNotMatch(renderCapabilityLine({ classes: ['web'], complete: false }), /hermes|openclaw|engine|toolset|manifest|capabilit/i);
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
