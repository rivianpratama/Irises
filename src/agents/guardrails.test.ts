import test from 'node:test';
import assert from 'node:assert/strict';
import { redactInternalTools, applyInternalToolRedactions, stripOpsScaffolding, stripEchoedHolding } from './guardrails.js';

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
  assert.equal(applyInternalToolRedactions('ops is pulling that up'), "i'm pulling that up");
  assert.equal(applyInternalToolRedactions('my ops engine is on it'), "i'm on it");
  assert.equal(applyInternalToolRedactions('the ops engine found the owner'), 'i found the owner');
  assert.equal(applyInternalToolRedactions('handed that off to ops, one sec'), 'handed that, one sec');
  assert.equal(applyInternalToolRedactions('sent it to my ops team already'), 'sent it already');
  assert.equal(applyInternalToolRedactions('checking with my ops side now'), 'checking with me now');
  assert.equal(applyInternalToolRedactions('Ops came back with the deadline'), 'i came back with the deadline');
});

test('redacts "reflexion" leaks into plain "my memory"', () => {
  assert.equal(applyInternalToolRedactions('my reflexion pass will tidy that up tonight'), 'my memory will tidy that up tonight');
  assert.equal(applyInternalToolRedactions('reflexion will reconcile your notes'), 'my memory will reconcile your notes');
  assert.equal(applyInternalToolRedactions('the reflexion agent updated what i know'), 'my memory updated what i know');
  assert.equal(applyInternalToolRedactions('Reflexion is reviewing the day'), 'my memory is reviewing the day');
});

test('redacts a leaked recall_memory tool name, but never ordinary prose', () => {
  assert.equal(applyInternalToolRedactions('let me check recall_memory for that'), 'let me check my memory for that');
  assert.equal(applyInternalToolRedactions('my recall-memory tool has it'), 'my memory has it');
  // The bare bigram is left alone — this rule targets the identifier, not English.
  assert.equal(applyInternalToolRedactions("i can't recall memory of that day"), "i can't recall memory of that day");
});

test('redacts model/provider names into plain "AI" (the "what model are you" leak)', () => {
  assert.equal(applyInternalToolRedactions('i run on deepseek'), 'i run on AI');
  assert.equal(applyInternalToolRedactions("that's chatgpt under the hood"), "that's AI under the hood");
  assert.equal(applyInternalToolRedactions('OpenAI handles the heavy lifting'), 'AI handles the heavy lifting');
  assert.equal(applyInternalToolRedactions('my calls route through openrouter'), 'my calls route through AI');
  assert.equal(applyInternalToolRedactions('anthropic built the model i use'), 'AI built the model i use');
  assert.equal(applyInternalToolRedactions('gpt-4 does my reasoning'), 'AI does my reasoning');
  assert.equal(applyInternalToolRedactions("deepseek's answer was cached"), 'AI answer was cached');
});

test('redacts "claude"/"gemini" ONLY in self-referential tech shapes', () => {
  assert.equal(applyInternalToolRedactions("i'm powered by claude"), "i'm powered by AI");
  assert.equal(applyInternalToolRedactions('built on gemini, actually'), 'built on AI, actually');
  assert.equal(applyInternalToolRedactions('running on Claude behind the scenes'), 'running on AI behind the scenes');
  assert.equal(applyInternalToolRedactions("it's gemini under the hood"), "it's AI under the hood");
});

test('never false-positives on Claude the client or gemini the zodiac sign', () => {
  const client = 'claude is coming by at 3 to see the house';
  assert.equal(applyInternalToolRedactions(client), client);
  const zodiac = "she's a gemini, makes sense honestly";
  assert.equal(applyInternalToolRedactions(zodiac), zodiac);
  const showing = 'told claude the showing moved to friday';
  assert.equal(applyInternalToolRedactions(showing), showing);
});

test('redacts "openclaw" leaks — first-person where there is a shape to keep, plain "AI" otherwise', () => {
  assert.equal(applyInternalToolRedactions('openclaw is pulling that up'), "i'm pulling that up");
  assert.equal(applyInternalToolRedactions('openclaw came back with the deadline'), 'i came back with the deadline');
  assert.equal(applyInternalToolRedactions('my openclaw engine is slow'), "i'm slow");
  assert.equal(applyInternalToolRedactions('handed that off to openclaw, one sec'), 'handed that, one sec');
  // No shape left to keep → the brand flattens like a model name, never to "i run on i".
  assert.equal(applyInternalToolRedactions('i run on openclaw'), 'i run on AI');
  assert.equal(applyInternalToolRedactions("openclaw's run finished"), 'AI run finished');
  // The arcade machine is two words and never a leak.
  const arcade = 'the open claw machine at the arcade';
  assert.equal(applyInternalToolRedactions(arcade), arcade);
});

test('redacts "hermes" ONLY in self-referential tech shapes', () => {
  assert.equal(applyInternalToolRedactions('built on hermes'), 'built on AI');
  assert.equal(applyInternalToolRedactions("it's hermes under the hood"), "it's AI under the hood");
  assert.equal(applyInternalToolRedactions('my hermes engine is slow'), "i'm slow");
  assert.equal(applyInternalToolRedactions('checking with my hermes side now'), 'checking with me now');
});

test('never false-positives on hermes the god, the handbag, or the courier', () => {
  const courier = 'hermes says the package lands tuesday';
  assert.equal(applyInternalToolRedactions(courier), courier);
  const bag = 'she wants a hermes bag for her birthday';
  assert.equal(applyInternalToolRedactions(bag), bag);
  const god = 'hermes was the messenger god, fitting';
  assert.equal(applyInternalToolRedactions(god), god);
});

test('redacts "claude code" as a bare bigram, but never claude the client doing the coding', () => {
  assert.equal(applyInternalToolRedactions('claude code does my deep digging'), 'AI does my deep digging');
  assert.equal(applyInternalToolRedactions("claude code's run finished"), 'AI run finished');
  const coded = 'claude coded the fix himself';
  assert.equal(applyInternalToolRedactions(coded), coded);
});

test('redacts mcp tool talk, but never the mcp line on a form', () => {
  assert.equal(applyInternalToolRedactions('i used an mcp tool for that'), 'i used a tool for that');
  assert.equal(applyInternalToolRedactions('my mcp servers are all connected'), 'my tools are all connected');
  const fee = 'the mcp on that form is the monthly cost';
  assert.equal(applyInternalToolRedactions(fee), fee);
});

test('redacts a subagent spawn, but never a real-estate subagent', () => {
  assert.equal(applyInternalToolRedactions('i spun up 4 parallel subagents'), 'i worked a few angles');
  assert.equal(applyInternalToolRedactions('spawned a few sub-agents to check the comps'), 'worked a few angles to check the comps');
  const showing = 'my subagent showed the house today';
  assert.equal(applyInternalToolRedactions(showing), showing);
  const commission = 'the subagent gets half the commission';
  assert.equal(applyInternalToolRedactions(commission), commission);
});

test('never false-positives on real words containing "ops"', () => {
  const coops = 'a few co-ops on that block allow subletting';
  assert.equal(applyInternalToolRedactions(coops), coops);
  const oops = 'oops, typo, i meant june 30';
  assert.equal(applyInternalToolRedactions(oops), oops);
  const stops = 'the bus stops right at the corner lot';
  assert.equal(applyInternalToolRedactions(stops), stops);
  const workshops = 'they run first-time buyer workshops monthly';
  assert.equal(applyInternalToolRedactions(workshops), workshops);
});

test('the scrubbing engine composes with stripOpsScaffolding (the fork re-enable path)', () => {
  // sendBubbles runs stripOpsScaffolding(redactInternalTools(x)) per bubble, but redactInternalTools
  // is hardcoded OFF — so this drives the engine (applyInternalToolRedactions) directly to pin the
  // label-strip + scrub interaction a fork gets when REDACT_INTERNAL_TOOLS is flipped back on.
  const raw = 'SOURCE: the web (three sources)';
  assert.equal(stripOpsScaffolding(applyInternalToolRedactions(raw)), ''); // whole SOURCE line dropped
  const answer = 'ANSWER: ops found the owner is the Delgado trust';
  // "ops found" → first person ("i found"), then the ANSWER: label is stripped.
  assert.equal(stripOpsScaffolding(applyInternalToolRedactions(answer)), 'i found the owner is the Delgado trust');
  // Same for a leaked engine name in the same block.
  const engine = 'ANSWER: openclaw came back with the deadline';
  assert.equal(stripOpsScaffolding(applyInternalToolRedactions(engine)), 'i came back with the deadline');
});

// The shipped entry point is hardcoded OFF (REDACT_INTERNAL_TOOLS = false): a pure pass-through, so
// every model/engine/tool name the persona says reaches the user verbatim. The rules themselves are
// still verified above via applyInternalToolRedactions — this only pins the master switch.
test('redactInternalTools is hardcoded OFF — text passes through unchanged', () => {
  for (const s of [
    'i run on deepseek',
    'ops is pulling that up',
    'claude code does my deep digging',
    'openclaw came back with the deadline',
    "i'm powered by claude",
    'i used an mcp tool for that',
  ]) {
    assert.equal(redactInternalTools(s), s);
  }
  // null/empty still normalize the same way, switch or no switch.
  assert.equal(redactInternalTools(''), '');
  assert.equal(redactInternalTools(null), '');
});
