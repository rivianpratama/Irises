// The side-effect lexicon: the ENGLISH fast path under the approval gate. Two claims are pinned
// here, and they are the ones the gate's honesty rests on:
//   • an English request that would have the ENGINE act in the world reads 'act' even when the model
//     forgot the tag — whole-phrase, clause-bounded, with the negation and quote guards that keep
//     "don't send anything" and a quoted song title out of it;
//   • a request in ANY OTHER LANGUAGE is invisible to this list by design (no other-language word
//     lists anywhere in the code, user rule 2026-09-04) and reaches 'act' only through the model's
//     own `effect` tag — the language-agnostic path, pinned below on a Spanish request.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDE_EFFECT_PHRASES,
  classifySideEffect,
  coerceEffect,
  findSideEffectPhrase,
  opsApprovalGateEnabled,
} from './sideEffects.js';

test('an English side-effecting request reads act off the lexicon alone', () => {
  const v = classifySideEffect('send an email to my landlord saying rent is late', 'read');
  assert.equal(v.effect, 'act');
  assert.equal(v.trigger, 'lexicon');
  assert.equal(v.phrase, 'send');
});

test('the model tag alone is enough — and both sources agreeing says both', () => {
  const llmOnly = classifySideEffect('let the office know i am running late', 'act');
  assert.equal(llmOnly.effect, 'act');
  assert.equal(llmOnly.trigger, 'llm');
  assert.equal(llmOnly.phrase, undefined);

  const both = classifySideEffect('reply to the landlord thread for me', 'act');
  assert.equal(both.effect, 'act');
  assert.equal(both.trigger, 'both');
  assert.equal(both.phrase, 'reply to');
});

test('a plain research ask is read, with nothing triggering', () => {
  const v = classifySideEffect('how much does a flight to bali cost in november', 'read');
  assert.deepEqual(v, { effect: 'read', trigger: 'none' });
});

test('negation keeps a mention out of it', () => {
  for (const req of [
    "don't send anything to my landlord",
    'do not send that email yet',
    'never post anything on my behalf',
  ]) {
    assert.equal(classifySideEffect(req, 'read').effect, 'read', req);
  }
});

test('quoted text inside the request is data, not an instruction', () => {
  const v = classifySideEffect("search for the song 'send me an angel'", 'read');
  assert.deepEqual(v, { effect: 'read', trigger: 'none' });
  assert.equal(findSideEffectPhrase('look up the album "order of the phoenix"'), undefined);
  // An apostrophe in a possessive must not open a quote span and swallow the real phrase.
  assert.equal(findSideEffectPhrase("send my landlord's office the new date"), 'send');
});

test('a phrase has to land inside ONE clause', () => {
  // The letters of "reply to" are both there, either side of a sentence break.
  assert.equal(findSideEffectPhrase('what should i reply. to be honest it can wait'), undefined);
  // And a whole-phrase test, not a substring one: "sending", "ordering", "remover" are not the words.
  assert.equal(findSideEffectPhrase('is sending it worth the trouble'), undefined);
  assert.equal(findSideEffectPhrase('what is the ordering of those clauses'), undefined);
});

test('a mutating request in another language is caught ONLY by the model tag', () => {
  const ask = 'envía un correo a mi casero diciendo que el alquiler llega tarde';
  // The lexicon is English-only, on purpose: it sees nothing here.
  assert.equal(findSideEffectPhrase(ask), undefined);
  assert.deepEqual(classifySideEffect(ask, 'read'), { effect: 'read', trigger: 'none' });
  // The model reads every language, so its tag is the language-agnostic path.
  const tagged = classifySideEffect(ask, 'act');
  assert.equal(tagged.effect, 'act');
  assert.equal(tagged.trigger, 'llm');
});

test('coerceEffect: only the literal act is act, everything else is read', () => {
  assert.equal(coerceEffect('act'), 'act');
  assert.equal(coerceEffect('ACT'), 'act');
  assert.equal(coerceEffect(' act '), 'act');
  for (const junk of ['read', 'write', 'banana', '', undefined, null, 7, {}]) {
    assert.equal(coerceEffect(junk), 'read', String(junk));
  }
});

test('every phrase in the lexicon is lowercase, trimmed and single-spaced', () => {
  for (const p of SIDE_EFFECT_PHRASES) {
    assert.equal(p, p.toLowerCase().trim().replace(/\s+/g, ' '), p);
    assert.match(p, /^[a-z]+( [a-z]+)*$/, p);
  }
  assert.equal(new Set(SIDE_EFFECT_PHRASES).size, SIDE_EFFECT_PHRASES.length, 'no duplicates');
});

test('the flag parses like every sibling: default ON, only an explicit off turns it off', () => {
  const prev = process.env.OPS_APPROVAL_GATE;
  try {
    delete process.env.OPS_APPROVAL_GATE;
    assert.equal(opsApprovalGateEnabled(), true);
    for (const on of ['true', '1', 'on', 'yes', 'YES', ' on ']) {
      process.env.OPS_APPROVAL_GATE = on;
      assert.equal(opsApprovalGateEnabled(), true, on);
    }
    for (const off of ['off', 'false', '0', 'no', 'nope']) {
      process.env.OPS_APPROVAL_GATE = off;
      assert.equal(opsApprovalGateEnabled(), false, off);
    }
  } finally {
    if (prev === undefined) delete process.env.OPS_APPROVAL_GATE;
    else process.env.OPS_APPROVAL_GATE = prev;
  }
});
