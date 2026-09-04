// The consent detector: one reply, three answers, and only one of them starts an action in the
// world. English is the fast free path; every other language reaches the same verdict through the
// classify lane, which is the language-agnostic half (no other-language word lists anywhere —
// user rule 2026-09-04).
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConsent, resolveConsent, CONSENT_MAX_WORDS, CONSENT_CLASSIFY_MAX_WORDS,
} from './consent.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

function lane(text: string): { llm: (req: LlmRequest) => Promise<LlmResult>; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  return {
    seen,
    llm: async (req: LlmRequest) => {
      seen.push(req);
      return { text, toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
    },
  };
}

const ASK = 'email my landlord that rent is late';

// ── the English lexicon ──────────────────────────────────────────────────────

test('every yes in the lexicon settles as a yes', () => {
  for (const reply of ['yes', 'Yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go', 'go ahead', 'do it', 'send it', 'book it', 'please do', 'yes go ahead']) {
    assert.equal(classifyConsent(reply), 'yes', reply);
  }
});

test('every no in the lexicon settles as a no', () => {
  for (const reply of ['no', 'Nope', "don't", 'do not', 'stop', 'wait', 'hold on', 'cancel', 'not now', 'skip', 'later', 'no thanks']) {
    assert.equal(classifyConsent(reply), 'no', reply);
  }
});

test('a negated yes is a no, not a yes', () => {
  assert.equal(classifyConsent("don't do it"), 'no');
  assert.equal(classifyConsent('not ok'), 'no');
});

test('a mixed reply settles nothing', () => {
  assert.equal(classifyConsent('yes but not now'), 'unclear');
  assert.equal(classifyConsent('ok wait'), 'unclear');
});

test('a yes word carried along by a reply about something else settles nothing', () => {
  // The lexicon matches whole words inside a clause, so before this a "yes" word anywhere under the
  // word cap was consent — and "go check the weather" would have sent the parked email.
  for (const reply of ["ok what's the weather", 'how did that go', 'go check the weather', 'sure lets talk about tomorrow']) {
    assert.equal(classifyConsent(reply), 'unclear', reply);
  }
});

test('a yes wrapped in nothing but filler is still a yes', () => {
  for (const reply of ['yes please', 'sure, send it', 'yep go for it', 'ok do it', 'yeah go ahead', 'yes, thank you']) {
    assert.equal(classifyConsent(reply), 'yes', reply);
  }
});

test('a reply longer than the word cap is never consent', () => {
  const long = 'yes i think that is probably the right thing to do here';
  assert.ok(long.split(' ').length > CONSENT_MAX_WORDS);
  assert.equal(classifyConsent(long), 'unclear');
});

test('a question is never consent, however it is worded', () => {
  // The one guard the lexicon needs: "go" is a yes word, and "how did that go?" is not a yes.
  assert.equal(classifyConsent('how did that go?'), 'unclear');
  assert.equal(classifyConsent('did you send it?'), 'unclear');
});

test('anything the English lexicon does not settle is unclear — including every other language', () => {
  assert.equal(classifyConsent(''), 'unclear');
  assert.equal(classifyConsent('what did you find'), 'unclear');
  assert.equal(classifyConsent('sí, hazlo'), 'unclear');
  assert.equal(classifyConsent('hazlo ahora'), 'unclear');
});

// ── the classify lane, the language-agnostic path ────────────────────────────

test('a non-English yes is unclear to the lexicon and resolved by the classify lane', async () => {
  const l = lane('YES');
  assert.equal(await resolveConsent('sí, hazlo', ASK, { llm: l.llm }), 'yes');
  assert.equal(l.seen.length, 1, 'the lane was asked exactly once');
  assert.equal(l.seen[0].role, 'classify');
  assert.match(String(l.seen[0].messages[0].content), /hazlo/);
  assert.match(String(l.seen[0].messages[0].content), /rent is late/, 'the lane sees the action it is judging a reply to');
});

test('the lane is never asked when the English lexicon already settled it', async () => {
  const l = lane('YES');
  assert.equal(await resolveConsent('go ahead', ASK, { llm: l.llm }), 'yes');
  assert.equal(await resolveConsent('nope', ASK, { llm: l.llm }), 'no');
  assert.equal(l.seen.length, 0);
});

test('the lane is never asked about a reply too long to be an answer', async () => {
  const l = lane('YES');
  const long = new Array(CONSENT_CLASSIFY_MAX_WORDS + 2).fill('palabra').join(' ');
  assert.equal(await resolveConsent(long, ASK, { llm: l.llm }), 'unclear');
  assert.equal(l.seen.length, 0);
});

test('a lane verdict of NO is a no, and anything else is unclear', async () => {
  assert.equal(await resolveConsent('no lo hagas', ASK, { llm: lane('NO').llm }), 'no');
  assert.equal(await resolveConsent('quizás', ASK, { llm: lane('UNCLEAR').llm }), 'unclear');
  assert.equal(await resolveConsent('quizás', ASK, { llm: lane('who knows').llm }), 'unclear');
});

test('a dead classify lane is unclear — never a yes', async () => {
  const thrown = async () => { throw new Error('no lane configured'); };
  assert.equal(await resolveConsent('sí, hazlo', ASK, { llm: thrown as never }), 'unclear');
});
