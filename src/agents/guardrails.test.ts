import test from 'node:test';
import assert from 'node:assert/strict';
import { redactInternalTools, stripOpsScaffolding, stripEchoedHolding } from './guardrails.js';

// ── stripEchoedHolding: the fused-bubble bug ────────────────────────────────────────────────────
// The Composer retyped its holding line glued to the answer with no whitespace, and the 19-word
// result slid under the 20-word splitter ceiling — shipping as one fused bubble.

const HOLDING = 'checking your inbox for any repair requests on a Pine property now';

test('strips the exact reported fusion (zero-space echo)', () => {
  const fused = `checking your inbox for any repair requests on a Pine property nownothing under "Pine" in your inbox or deals`;
  assert.equal(stripEchoedHolding(fused, HOLDING), 'nothing under "Pine" in your inbox or deals');
});

test('strips an echo that differs in case and punctuation', () => {
  const fused = `Checking your inbox for any repair requests on a Pine property, now! nothing under Pine in there`;
  assert.equal(stripEchoedHolding(fused, HOLDING), 'nothing under Pine in there');
});

test('strips an echo followed by a separator or newline, trimming the seam', () => {
  assert.equal(stripEchoedHolding(`${HOLDING}\n---\nnothing under Pine`, HOLDING), 'nothing under Pine');
  assert.equal(stripEchoedHolding(`${HOLDING} — nothing under Pine`, HOLDING), 'nothing under Pine');
});

test('leaves a reply alone when it only reuses a few holding words', () => {
  const reply = 'checking your inbox turned up nothing on Pine';
  assert.equal(stripEchoedHolding(reply, HOLDING), reply);
});

test('a reply that IS only the echo is returned unchanged (never blank)', () => {
  assert.equal(stripEchoedHolding(HOLDING, HOLDING), HOLDING);
  assert.equal(stripEchoedHolding(`${HOLDING}...`, HOLDING), `${HOLDING}...`);
});

test('strips an echo of only the LAST bubble of a multi-bubble holding text (the Ops-dispatch fusion)', () => {
  const multi = 'lemme find that contract\n---\nscanning your inbox now';
  // The model continues "straight from" the last bubble it sent, glued with no space.
  assert.equal(stripEchoedHolding('scanning your inbox nowokay found it, June 12', multi), 'okay found it, June 12');
  // Echo of the first bubble alone strips too, seam punctuation trimmed.
  assert.equal(stripEchoedHolding('lemme find that contract, found it — June 12', multi), 'found it — June 12');
});

test('strips chained echoes of consecutive bubbles', () => {
  const multi = 'on it\n---\nchecking the records now';
  assert.equal(stripEchoedHolding('on itchecking the records nowowner is the delgado trust', multi), 'owner is the delgado trust');
});

test('a reply that IS only a bubble echo is returned unchanged (never blank)', () => {
  const multi = 'lemme find that contract\n---\nscanning your inbox now';
  assert.equal(stripEchoedHolding('scanning your inbox now', multi), 'scanning your inbox now');
});

test('passthrough on missing holding text or empty reply', () => {
  const reply = 'nothing under Pine in your inbox';
  assert.equal(stripEchoedHolding(reply, undefined), reply);
  assert.equal(stripEchoedHolding(reply, null), reply);
  assert.equal(stripEchoedHolding(reply, ''), reply);
  assert.equal(stripEchoedHolding('', HOLDING), '');
});

// The exact leak from production: a user asked "what is my latest email" and the composer-failure
// fallback relayed Ops' raw ANSWER:/SOURCE:/FLAGS: block, split into bubbles. stripOpsScaffolding is
// the deterministic tripwire in the single send path that keeps that scaffolding off the phone.

test('drops SOURCE:/FLAGS:/ACTIONS: machinery lines entirely', () => {
  assert.equal(stripOpsScaffolding('SOURCE: Email (sample@example.com inbox)'), '');
  assert.equal(stripOpsScaffolding('FLAGS: Worth a look'), '');
  assert.equal(stripOpsScaffolding('ACTIONS: ran a script over the CSV, produced a summary table'), '');
  assert.equal(stripOpsScaffolding('  source: public records  '), ''); // case + whitespace tolerant
  assert.equal(stripOpsScaffolding('  actions: scheduled a follow-up for thursday 9am  '), ''); // case + whitespace tolerant
});

test('strips label prefixes but keeps the value', () => {
  assert.equal(stripOpsScaffolding('ANSWER: Inspection deadline is July 8, 2026.'), 'Inspection deadline is July 8, 2026.');
  assert.equal(stripOpsScaffolding("Subject: \"Security alert\""), '"Security alert"');
  assert.equal(stripOpsScaffolding('Sender: Google <no-reply@accounts.google.com>'), 'Google <no-reply@accounts.google.com>');
  assert.equal(stripOpsScaffolding('Summary: an app was granted access'), 'an app was granted access');
  assert.equal(stripOpsScaffolding('NO RESULT: searched their email, found nothing'), 'searched their email, found nothing');
});

test('handles the full multi-line raw Ops block (the production leak)', () => {
  const raw = [
    'ANSWER: Most recent email in the user\'s inbox (Jul 2, 2026, 6:27 PM):',
    'Subject: "Security alert"',
    'Sender: Google <no-reply@accounts.google.com>',
    'Summary: Google says a third-party app was granted access.',
    'SOURCE: Email (sample@example.com inbox)',
    'ACTIONS: flagged the message, scheduled a follow-up check',
    'FLAGS: Worth a look',
  ].join('\n');
  const out = stripOpsScaffolding(raw);
  // No structural labels survive.
  assert.doesNotMatch(out, /^\s*(ANSWER|SOURCE|FLAGS|ACTIONS|SUMMARY|SUBJECT|SENDER|NO RESULT)\s*:/im);
  // The values do survive.
  assert.match(out, /Most recent email in the user's inbox/);
  assert.match(out, /"Security alert"/);
  assert.match(out, /Google says a third-party app was granted access/);
  // SOURCE/ACTIONS/FLAGS lines are gone completely.
  assert.doesNotMatch(out, /Email \(sample@example/);
  assert.doesNotMatch(out, /scheduled a follow-up check/);
  assert.doesNotMatch(out, /Worth a look/);
});

test('leaves normal Irises chat text untouched (no false positives)', () => {
  const normal = "ok, option period ends march 14\n---\nyou've still got your contingency rights til then";
  assert.equal(stripOpsScaffolding(normal), normal);
  // A colon mid-sentence is not a line-leading label and must not trip it.
  const midColon = 'the timing is the real issue: the option closes friday';
  assert.equal(stripOpsScaffolding(midColon), midColon);
});

test('idempotent and null-safe', () => {
  const once = stripOpsScaffolding('ANSWER: closing is june 30\nSOURCE: public records');
  assert.equal(stripOpsScaffolding(once), once);
  assert.equal(stripOpsScaffolding(''), '');
  assert.equal(stripOpsScaffolding(null), '');
  assert.equal(stripOpsScaffolding(undefined), '');
});

// The "Ops" seam: the back-line agent's name must never reach the user — to them there is only
// Irises. The rules degrade the common leak shapes to first-person instead of garbled text.

test('redacts "ops" leaks into first-person Irises', () => {
  assert.equal(redactInternalTools('ops is pulling that up'), "i'm pulling that up");
  assert.equal(redactInternalTools('my ops engine is on it'), "i'm on it");
  assert.equal(redactInternalTools('the ops engine found the owner'), 'i found the owner');
  assert.equal(redactInternalTools('handed that off to ops, one sec'), 'handed that, one sec');
  assert.equal(redactInternalTools('sent it to my ops team already'), 'sent it already');
  assert.equal(redactInternalTools('checking with my ops side now'), 'checking with me now');
  assert.equal(redactInternalTools('Ops came back with the deadline'), 'i came back with the deadline');
});

test('redacts "reflexion" leaks into plain "my memory"', () => {
  assert.equal(redactInternalTools('my reflexion pass will tidy that up tonight'), 'my memory will tidy that up tonight');
  assert.equal(redactInternalTools('reflexion will reconcile your notes'), 'my memory will reconcile your notes');
  assert.equal(redactInternalTools('the reflexion agent updated what i know'), 'my memory updated what i know');
  assert.equal(redactInternalTools('Reflexion is reviewing the day'), 'my memory is reviewing the day');
});

test('redacts a leaked recall_memory tool name, but never ordinary prose', () => {
  assert.equal(redactInternalTools('let me check recall_memory for that'), 'let me check my memory for that');
  assert.equal(redactInternalTools('my recall-memory tool has it'), 'my memory has it');
  // The bare bigram is left alone — this rule targets the identifier, not English.
  assert.equal(redactInternalTools("i can't recall memory of that day"), "i can't recall memory of that day");
});

test('redacts model/provider names into plain "AI" (the "what model are you" leak)', () => {
  assert.equal(redactInternalTools('i run on deepseek'), 'i run on AI');
  assert.equal(redactInternalTools("that's chatgpt under the hood"), "that's AI under the hood");
  assert.equal(redactInternalTools('OpenAI handles the heavy lifting'), 'AI handles the heavy lifting');
  assert.equal(redactInternalTools('my calls route through openrouter'), 'my calls route through AI');
  assert.equal(redactInternalTools('anthropic built the model i use'), 'AI built the model i use');
  assert.equal(redactInternalTools('gpt-4 does my reasoning'), 'AI does my reasoning');
  assert.equal(redactInternalTools("deepseek's answer was cached"), 'AI answer was cached');
});

test('redacts "claude"/"gemini" ONLY in self-referential tech shapes', () => {
  assert.equal(redactInternalTools("i'm powered by claude"), "i'm powered by AI");
  assert.equal(redactInternalTools('built on gemini, actually'), 'built on AI, actually');
  assert.equal(redactInternalTools('running on Claude behind the scenes'), 'running on AI behind the scenes');
  assert.equal(redactInternalTools("it's gemini under the hood"), "it's AI under the hood");
});

test('never false-positives on Claude the client or gemini the zodiac sign', () => {
  const client = 'claude is coming by at 3 to see the house';
  assert.equal(redactInternalTools(client), client);
  const zodiac = "she's a gemini, makes sense honestly";
  assert.equal(redactInternalTools(zodiac), zodiac);
  const showing = 'told claude the showing moved to friday';
  assert.equal(redactInternalTools(showing), showing);
});

test('never false-positives on real words containing "ops"', () => {
  const coops = 'a few co-ops on that block allow subletting';
  assert.equal(redactInternalTools(coops), coops);
  const oops = 'oops, typo, i meant june 30';
  assert.equal(redactInternalTools(oops), oops);
  const stops = 'the bus stops right at the corner lot';
  assert.equal(redactInternalTools(stops), stops);
  const workshops = 'they run first-time buyer workshops monthly';
  assert.equal(redactInternalTools(workshops), workshops);
});

test('composes with redactInternalTools the way sendBubbles applies them', () => {
  // sendBubbles runs stripOpsScaffolding(redactInternalTools(x)) per bubble.
  const raw = 'SOURCE: the web (three sources)';
  assert.equal(stripOpsScaffolding(redactInternalTools(raw)), ''); // whole SOURCE line dropped
  const answer = 'ANSWER: ops found the owner is the Delgado trust';
  // "ops found" → first person ("i found"), then the ANSWER: label is stripped.
  assert.equal(stripOpsScaffolding(redactInternalTools(answer)), 'i found the owner is the Delgado trust');
});
