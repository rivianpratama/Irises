import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAtomicFacts, checkGrounding, groundOrDowngrade, corpusWindow } from './fidelity.js';

// checkGrounding is the deterministic Layer 1; groundOrDowngrade's Layer 2 needs the LLM, so the
// unit tests target Layer 1 (the always-on guarantee). FIDELITY_ENFORCE defaults to 'all'.

test('extracts currency/date/phone/email/address/name families', () => {
  const facts = extractAtomicFacts('Earnest is $7,500, closing July 21, 2026. Call Priya Johnson at (512) 555-4821 or dana@apex.com re 123 Main Street.');
  const fams = new Set(facts.map(f => f.family));
  for (const fam of ['currency', 'date', 'phone', 'email', 'address', 'name'] as const) {
    assert.ok(fams.has(fam), `missing family ${fam}`);
  }
});

test('grounds facts present in the corpus (format-normalized)', () => {
  const summary = 'ANSWER: earnest money is $7,500; closing July 21, 2026.';
  const corpus = 'TOOL get_deal_facts RESULT:\n{"earnest_money_amount":7500,"closing_date":"2026-07-21"}';
  const r = checkGrounding(summary, corpus, '210 Cedar Avenue');
  assert.equal(r.ok, true, `unexpected ungrounded: ${JSON.stringify(r.ungrounded)}`);
});

test('$489k == $489,000 == 489000 all ground against each other', () => {
  const corpus = 'TOOL x RESULT: accepted price 489,000';
  assert.equal(checkGrounding('we accepted $489k', corpus, '').ok, true);
  assert.equal(checkGrounding('we accepted $489,000', corpus, '').ok, true);
});

test('a dollar amount does NOT ground off an unrelated number (sqft / street #) in the corpus', () => {
  // Review finding: pooling every bare number let a fabricated $ ground off sqft/street numbers.
  const corpus = 'TOOL search_deal_emails RESULT:\n7500 Oak Ridge Dr, 5000 sqft, 3 bed 2 bath';
  assert.ok(checkGrounding('earnest is $5,000', corpus, '').ungrounded.some(f => f.family === 'currency'), '$5,000 must not ground off 5000 sqft');
  assert.ok(checkGrounding('price was $7,500', corpus, '').ungrounded.some(f => f.family === 'currency'), '$7,500 must not ground off the street number');
});

test('a fabricated phone does NOT ground by spanning two real numbers in the corpus', () => {
  // Review finding: the old digits-substring check grounded a number straddling the boundary.
  const corpus = 'TOOL contact_identify RESULT:\n(512) 555-4821 and (737) 555-2290';
  const r = checkGrounding('call them at 482-173-7555', corpus, '');
  assert.ok(r.ungrounded.some(f => f.family === 'phone'), 'boundary-spanning fabricated phone must be flagged');
});

test('numeric slash dates are extracted even after a word (audit: month-branch used to swallow them)', () => {
  // "closing 7/4/2026" used to match as "closing 7" and drop the real date entirely.
  const good = checkGrounding('ANSWER: closing 7/4/2026.', 'TOOL x RESULT: closing_date 2026-07-04', '');
  assert.equal(good.ok, true, 'a real slash date must ground against its ISO form');
  const bad = checkGrounding('ANSWER: closing 7/9/2026.', 'TOOL x RESULT: closing_date 2026-07-04', '');
  assert.ok(bad.ungrounded.some(f => f.family === 'date'), 'a fabricated slash date must be flagged');
});

test('currency ranges carry the trailing scale to both endpoints ($450-475k)', () => {
  const corpus = 'TOOL x RESULT: comps run $450,000 to $475,000';
  assert.equal(checkGrounding('expect $450-475k for it', corpus, '').ok, true, 'range endpoints must scale with the shared suffix');
});

test('a currency word cannot reach across an unrelated JSON field to ground a number', () => {
  // "price_note":"x","sqft":5000 — "price" must not ground $5,000 via the 5000 two fields later.
  const corpus = 'TOOL x RESULT: {"price_note":"pending","sqft":5000}';
  const r = checkGrounding('the price is $5,000', corpus, '');
  assert.ok(r.ungrounded.some(f => f.family === 'currency'), 'cross-field grounding must not happen');
});

test('a two-token company name grounds when either token appears in the corpus', () => {
  const corpus = 'TOOL search RESULT:\ncommitment letter from Bright Lending is overdue';
  assert.ok(!checkGrounding('chase Bright Lending on the letter', corpus, '').ungrounded.some(f => f.family === 'name'));
});

test('a fabricated NMLS/file identifier is suppressed; the real one grounds (live-test gap)', () => {
  const corpus = 'TOOL search RESULT:\nRachel Ortiz, First National Mortgage, NMLS #778201; escrow file LS-24418';
  // The live test caught "NMLS #2123456" shipping — a labeled id fits no other family.
  const bad = checkGrounding('her NMLS #2123456', corpus, '');
  assert.ok(bad.ungrounded.some(f => f.family === 'identifier'), 'fabricated NMLS id must be flagged');
  assert.equal(checkGrounding('her NMLS #778201 checks out', corpus, '').ok, true);
  assert.equal(checkGrounding('escrow file #LS-24418', corpus, '').ok, true);
});

test('THE PATEL BUG: a dollar amount absent from the corpus is suppressed', () => {
  // Asked about Patel's earnest; corpus only has $7,500. A summary that says $5,000 (123 Main's
  // number) must be flagged — that fact is nowhere in the tool output.
  const summary = 'ANSWER: earnest money on the Patel contract is $5,000.';
  const corpus = 'TOOL get_deal_facts RESULT:\n{"earnest_money_amount":7500,"property_address":"210 Cedar Avenue"}';
  const r = checkGrounding(summary, corpus, 'Patel contract');
  assert.equal(r.ok, false);
  assert.ok(r.ungrounded.some(f => f.family === 'currency' && f.norm === '5000'));
});

test('fabricated person name (no surname in corpus) is suppressed under enforce=all', () => {
  const summary = 'ANSWER: that number belongs to Richard Blanchard.';
  const corpus = 'TOOL contact_identify RESULT:\nfound: Priya Johnson | (512) 555-4821';
  const r = checkGrounding(summary, corpus, 'who is 512-555-4821');
  assert.equal(r.ok, false);
  assert.ok(r.ungrounded.some(f => f.family === 'name'));
});

test('a real name whose surname is in the corpus is grounded', () => {
  const summary = 'ANSWER: that is Priya Johnson (the buyer).';
  const corpus = 'TOOL contact_identify RESULT:\nfound: Priya & Dev Johnson | (512) 555-4821';
  const r = checkGrounding(summary, corpus, '');
  assert.ok(!r.ungrounded.some(f => f.family === 'name'), `name wrongly ungrounded: ${JSON.stringify(r.ungrounded)}`);
});

test('a name echoed from the request/hints is grounded even if absent from corpus', () => {
  const summary = 'ANSWER: no history found for the Martinez family.';
  const corpus = 'TOOL client_history RESULT:\nno history found for that client';
  const r = checkGrounding(summary, corpus, 'Have I worked with the Martinez family before?');
  assert.ok(!r.ungrounded.some(f => f.family === 'name'));
});

test('an address the user named grounds; a fabricated wrong-city address does not', () => {
  const corpus = 'TOOL search_deal_emails RESULT:\nsubj: 123 Main Street executed';
  assert.equal(checkGrounding('the deal at 123 Main Street', corpus, '123 Main Street, Apple Town').ok, true);
  // A different fabricated address absent from both corpus and request → suppressed.
  const r = checkGrounding('per the docs on 900 Elmwood Boulevard', corpus, '123 Main Street');
  assert.ok(r.ungrounded.some(f => f.family === 'address'));
});

test('phone number not in corpus is suppressed; matching one grounds', () => {
  const corpus = 'TOOL contact_identify RESULT:\nAnika Patel | (737) 555-2290';
  assert.equal(checkGrounding("Anika's number is (737) 555-2290", corpus, '').ok, true);
  assert.ok(checkGrounding("Anika's number is 512-555-0199", corpus, '').ungrounded.some(f => f.family === 'phone'));
});

test('a summary with no hard facts is never suppressed', () => {
  const r = checkGrounding('ANSWER: the inspection contingency lets the buyer walk after the inspection.', '', '');
  assert.equal(r.ok, true);
});

test('day-first RFC-2822 corpus dates ground a month-first summary date', () => {
  // Gmail headers are day-first ("Mon, 28 Jun 2026") — before the day-first branch existed the
  // corpus contributed ZERO dates and every date Ops stated was ungroundable.
  const corpus = 'TOOL read_email RESULT:\nDate: Mon, 28 Jun 2026 09:14:22 -0500';
  assert.equal(checkGrounding('ANSWER: he wrote on Jun 28, 2026.', corpus, '').ok, true);
  // No-year variant matches on month-day.
  assert.equal(checkGrounding('ANSWER: he wrote on Jun 28.', corpus, '').ok, true);
});

test('day-first corpus dates are not mis-parsed month-first ("28 Jun 2026" is not June 20)', () => {
  const corpus = 'TOOL read_email RESULT:\nDate: Sun, 28 Jun 2026 09:14:22 -0500';
  const r = checkGrounding('ANSWER: he wrote on Jun 20, 2026.', corpus, '');
  assert.ok(r.ungrounded.some(f => f.family === 'date'), '"28 Jun 2026" must not ground June 20');
});

test('THE TOM REYNOLDS BUG: grounded answer with citation dates in SOURCE is not suppressed', async () => {
  // Production incident: the SOURCE line's dates ("Jun 28, 2026") could not ground against the
  // Gmail corpus's RFC-2822 headers, and grounding ran over the WHOLE scaffolded text — so a fully
  // grounded phone/email answer was downgraded to NO RESULT and the Composer asked a steering
  // question instead of relaying the number.
  const summary = [
    "ANSWER: Tom Reynolds's phone number is (512) 555-7788.",
    'His email is puzzlyvault@gmail.com.',
    'Found in his signature on the Pine St inspection thread.',
    'SOURCE: Gmail thread "the Pine St inspection" — Tom Reynolds emails dated Jun 28, 2026 and Jul 1, 2026',
    "FLAGS: Phone appears twice in Tom's email signature.",
    'No separate saved contact card surfaced in the results.',
    'Confidence high on the phone number.',
  ].join('\n');
  const corpus = [
    'TOOL search_deal_emails RESULT:',
    'thread: the Pine St inspection',
    'From: Tom Reynolds <puzzlyvault@gmail.com>',
    'Date: Sun, 28 Jun 2026 09:14:22 -0500',
    'Date: Wed, 1 Jul 2026 16:03:11 -0500',
    'Tom Reynolds | (512) 555-7788',
  ].join('\n');
  const g = await groundOrDowngrade(summary, corpus, "what's Tom's phone number", { enforce: true, useLayer2: false });
  assert.equal(g.downgraded, false, `wrongly suppressed: ${JSON.stringify(g.report.ungrounded)}`);
  assert.equal(g.summary, summary);
});

test('an ungroundable date in SOURCE/FLAGS never vetoes a grounded ANSWER', async () => {
  const summary = 'ANSWER: earnest money is $7,500.\nSOURCE: contract addendum dated Feb 14, 2026\nFLAGS: none';
  const corpus = 'TOOL get_deal_facts RESULT:\n{"earnest_money_amount":7500}';
  const g = await groundOrDowngrade(summary, corpus, '', { enforce: true, useLayer2: false });
  assert.equal(g.downgraded, false, `citation metadata suppressed the answer: ${JSON.stringify(g.report.ungrounded)}`);
});

test('a fabricated phone in the ANSWER section still suppresses (scoping did not weaken the backstop)', async () => {
  const summary = 'ANSWER: call him at (512) 555-0000.\nSOURCE: Gmail\nFLAGS: none';
  const corpus = 'TOOL search_deal_emails RESULT:\nTom Reynolds | (512) 555-7788';
  const g = await groundOrDowngrade(summary, corpus, '', { enforce: true, useLayer2: false });
  assert.equal(g.downgraded, true);
  assert.ok(g.summary.startsWith('NO RESULT:'));
});

test('web-search results seeded into the corpus ground web-sourced facts', () => {
  // Prod incident: Ops web-searched a public contact, found her org/phone/email, but every
  // web-sourced fact was flagged ungrounded (server results never entered the corpus) and the
  // assistant answered "no sign of her." With serverToolText seeded as a WEB SEARCH RESULTS entry,
  // they ground.
  const summary = 'ANSWER: Priya Johnson is at Northwind Labs; reach her at pjohnson@northwind.example or (414) 555-6676.';
  const corpus = [
    'CURRENT DATE: 2026-08-02 (August 2, 2026)',
    'WEB SEARCH RESULTS (step 3):',
    'Priya Johnson, pjohnson@northwind.example, (414) 555-6676 — Northwind Labs — https://northwind.example/team/pjohnson',
  ].join('\n\n');
  const r = checkGrounding(summary, corpus, 'who is Priya Johnson');
  assert.equal(r.ok, true, `web-sourced facts wrongly ungrounded: ${JSON.stringify(r.ungrounded)}`);
});

test('corpusWindow: short corpus passes through whole; a long one keeps head + tail', () => {
  const short = 'TOOL x RESULT: total 7500';
  assert.equal(corpusWindow(short), short, 'short corpus untouched');

  // A fact stated at the very END of a long run must survive into the Layer-2 window.
  const tailFact = 'TOOL read_email RESULT: her cell is (414) 555-6676';
  const long = 'A'.repeat(30_000) + '\n' + tailFact;
  const win = corpusWindow(long);
  assert.ok(win.length < long.length, 'long corpus is windowed');
  assert.ok(win.includes('(414) 555-6676'), 'the tail fact must be preserved');
  assert.ok(win.startsWith('AAAA'), 'the head is preserved too');
});

test('FIDELITY_ENFORCE=hard excludes names from suppression', () => {
  const prev = process.env.FIDELITY_ENFORCE;
  process.env.FIDELITY_ENFORCE = 'hard';
  try {
    const r = checkGrounding('that is Richard Blanchard.', 'TOOL x RESULT: Priya Johnson', 'who is this');
    assert.equal(r.ok, true, 'names should not suppress in hard mode');
    assert.ok(r.softUngrounded.some(f => f.family === 'name'));
  } finally {
    process.env.FIDELITY_ENFORCE = prev;
  }
});
