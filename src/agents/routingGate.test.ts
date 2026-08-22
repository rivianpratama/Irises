import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGrounding, salvageHoldingText } from './routingGate.js';

test('data-lookup questions require grounding (route to Ops)', () => {
  for (const q of [
    'look up the population of Tokyo',
    'who is the CEO of Stripe?',
    "what's the status of my order?",
    'check my inbox for the invoice',
    'did I get a reply from the bank?',
    'when did we last hear from Acme?',
    'how much does a Model 3 cost?',
    'find the email from Sarah',
    'pull up my calendar for tomorrow',
    'has the vendor responded yet?',
  ]) {
    assert.equal(needsGrounding(q), 'yes', `expected yes for: ${q}`);
  }
});

test('a leading ack must not shield a data question from the gate', () => {
  for (const q of [
    'ok look up the weather in Paris',
    'thanks! check my inbox for the invoice',
    'cool, how much does a Model 3 cost?',
    'ok cool — find the email from Sarah',
  ]) {
    assert.equal(needsGrounding(q), 'yes', `expected yes for: ${q}`);
  }
  // ...while a message that IS just the ack (or ack + social) stays local.
  for (const q of ['ok', 'ok cool', 'thanks!!', 'yes', 'ok, what does API mean?']) {
    assert.equal(needsGrounding(q), 'no', `expected no for: ${q}`);
  }
});

test('terminology / math / social are answered locally (no forced delegation)', () => {
  for (const q of [
    'what does API mean?',
    'what is a closure?',
    'explain how promises work',
    'thanks!',
    'hey, how are you?',
    "what's the difference between let and const?",
    'what is recursion?',
  ]) {
    assert.equal(needsGrounding(q), 'no', `expected no for: ${q}`);
  }
});

test('a URL flips even an otherwise-definitional message to grounded', () => {
  assert.equal(needsGrounding('what does this page say? https://example.com/article'), 'yes');
});

// ── The local-path regression (2026-08-22 live test, weak model) ────────────────────────────────
// Three real messages, one run. The LTS one matched the gate and came back perfect; the two that
// named a real path did NOT — and with nothing forcing them through the engine, the weak model
// emitted a SILENT turn for one and falsely refused the other ("no can do from here, that path is
// local to your machine") even though the engine runs on that machine and has the file tools.

test('a named filesystem path in a request is engine work, never recall', () => {
  for (const q of [
    'can you peek at what skill folders exist in my ~/.hermes/skills and name like 5 of them?',
    'seriously tho, can you actually check ~/.hermes/skills and tell me some folder names in there?',
    'whats the latest nodejs LTS version right now? can you look it up for me', // already passed; pinned
    'check ~/.hermes/skills',            // imperative, no question mark
    'ls ~/.hermes/skills',
    'peek at ./src and tell me whats there',
    'whats in /var/log/nginx?',
    'tail /var/log/foo please',
  ]) {
    assert.equal(needsGrounding(q), 'yes', `expected yes for: ${q}`);
  }
});

test('an inspection verb aimed at files/folders is engine work too', () => {
  for (const q of ['look in my downloads folder', 'list the files in there', 'peek at what folders are on disk']) {
    assert.equal(needsGrounding(q), 'yes', `expected yes for: ${q}`);
  }
});

test('the path screen keeps its precision: slashes in prose are not paths', () => {
  for (const q of [
    'either/or is fine with me',
    'read/write access is all i need',
    'lets do 50/50 on that',
    '8/22 works for me',
    'she said the km/h thing was wrong',
    "i'll check back later",
    'look, i already told them',
    // A path with no ask around it is someone narrating, not asking for a read.
    'i dropped it in ~/Documents yesterday',
    // Singular "file" is the attachment they just sent — that turn is delegate_to_ops WITH the
    // media, not a forced file-less delegation, so the gate must keep its hands off it.
    'can you read this file i sent?',
    'have a look at this file',
  ]) {
    assert.equal(needsGrounding(q), 'no', `expected no for: ${q}`);
  }
});

test("a forced delegation keeps the draft's human holding opener, drops the fabricated tail", () => {
  // The Martinez incident, as bubbles: two genuine holding lines, then an invented result + re-aim.
  const draft = [
    'lemme check your records for martinez',
    'give me one sec',
    'pulled your inbox for martinez threads, nothing surfaced',
    'check a different spelling or do you have a property on record for them?',
  ].join('\n---\n');
  assert.equal(salvageHoldingText(draft), 'lemme check your records for martinez\n---\ngive me one sec');
});

test('salvage stops at the first bubble that asserts an outcome, even bubble one', () => {
  assert.equal(salvageHoldingText("checked everywhere, there's no martinez on file"), null);
  assert.equal(salvageHoldingText('you sold them 412 Elm back in March\n---\nchecking the exact date now'), null);
});

test('salvage is conservative: ungrounded figures, questions, and non-holding prose salvage nothing', () => {
  assert.equal(salvageHoldingText('they closed at $410,000'), null);
  assert.equal(salvageHoldingText('do you mean the martinez on elm?'), null);
  assert.equal(salvageHoldingText(null), null);
  assert.equal(salvageHoldingText(''), null);
});

test('salvage caps at three bubbles (the persona 1–3 holding range) and keeps the legacy wire format', () => {
  const draft = ['pulling that up for you', 'hang on', 'checking one more place', 'lemme look'].join('\n---\n');
  assert.equal(salvageHoldingText(draft), 'pulling that up for you\n---\nhang on\n---\nchecking one more place');
});

// ── The Fallfirm-override regression (2026-07-06): Convo's persona-compliant holding texts MUST
// survive the salvage, or the later-returning Fallfirm line replaces Irises's own words wholesale. ──

test("a figure the user themselves said is an echo, not a fabrication — the persona's own example survives", () => {
  // "pulling the comps on 412 Maple now" is literally the persona's 1-bubble example; the old
  // any-digit rule killed it and Fallfirm overrode the reply.
  assert.equal(
    salvageHoldingText('pulling the comps on 412 Maple now', 'pull comps on 412 Maple'),
    'pulling the comps on 412 Maple now',
  );
  // Ungrounded digits still break, even with a ground present.
  assert.equal(salvageHoldingText('pulling it now, ARV was 410000 last time', 'pull comps on 412 Maple'), null);
  // A $ amount is never a holding line, grounded or not.
  assert.equal(salvageHoldingText('grabbing the $410,000 file now', 'the $410,000 file'), null);
  // No ground supplied → the old conservative behavior (every figure breaks).
  assert.equal(salvageHoldingText('pulling the comps on 412 Maple now'), null);
});

test("the persona's 3-bubble holding example (ack opener + holding + sign-off beat) survives whole", () => {
  const draft = ["okay that's a real question", 'digging through the thread now', 'back in a bit 🙂'].join('\n---\n');
  assert.equal(salvageHoldingText(draft), draft);
});

test('reassurance idioms from the persona ("scanning", "hang tight", "almost there", "on it") are holding-like', () => {
  for (const line of ['scanning your inbox now', 'still on it, hang tight', 'almost there', 'on it, boss']) {
    assert.equal(salvageHoldingText(line), line, `expected to survive: ${line}`);
  }
});

test('an ack alone never salvages — it promises no look, so the voiced fallback takes over', () => {
  assert.equal(salvageHoldingText("okay that's a real question"), null);
  assert.equal(salvageHoldingText('oof, the martinez file again'), null);
});

test('a lowercase assertion cannot sneak in as an ack opener', () => {
  // Starts with no interjection → not ACK_LIKE → breaks; the fabricated claim never ships.
  assert.equal(salvageHoldingText('the owner is the delgado trust\n---\nchecking the exact spelling now'), null);
});

test('an ack opener followed by a real holding bubble survives (pleasantry no longer lost)', () => {
  const draft = ["you're welcome!", 'pulling comps on 55 Birch now'].join('\n---\n');
  assert.equal(salvageHoldingText(draft, 'pull comps on 55 Birch'), draft);
});
