// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The idle gate. One boolean decides whether a reply may carry a hook at all, so these tests are
// about the three layers and the direction the gate falls when it cannot tell:
//
//   • THE VETOES OUTRANK EVERYTHING, including the fast path. "sure" is the most example-shaped
//     token in the file, and "sure" as the answer to her parked approval is a task.
//   • THE EXAMPLES ARE EXAMPLES. Nothing in the English list is a law: the same stall in another
//     language reaches the same answer through the injected classifier, and a token nobody listed
//     costs one call rather than a wrong reading.
//   • IT FAILS TOWARD TASK. `ask`, `unclear`, a garbled verdict, a thrown call, a deadline — every
//     one of them is a task, and the layer on the receipt still says the classifier ran.
//   • PURE. No clock, no lane, no network: the classifier is injected, so every layer here is
//     driven by a stub that counts its own calls.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isIdleTurn, idleVetoes, leafTokens, leafExamplesExtra, endsInQuestion,
  LEAF_EXAMPLES, IDLE_LAYERS, IDLE_MAX_TOKENS, IDLE_MAX_CHARS, QUESTION_MARKS,
  type IdleFacts, type IdleVerdict,
} from './idle.js';

/** The quiet turn: nothing arrived, nothing is running, nothing is outstanding. */
const CLEAR: IdleFacts = {
  attachmentNote: false, burstSize: 1, activeOps: false, pendingQuestion: false, consent: 'unclear',
};

const facts = (over: Partial<IdleFacts> = {}): IdleFacts => ({ ...CLEAR, ...over });

/** A classifier that answers one word and counts how often it was asked. */
function stub(verdict: IdleVerdict | string) {
  const calls: string[] = [];
  const fn = async (text: string): Promise<IdleVerdict> => {
    calls.push(text);
    return verdict as IdleVerdict;
  };
  return { fn, calls };
}

/** A classifier that fails the way a dead lane or a fired deadline fails. */
function thrower(message: string) {
  const calls: string[] = [];
  const fn = async (text: string): Promise<IdleVerdict> => {
    calls.push(text);
    throw new Error(message);
  };
  return { fn, calls };
}

/** Never reached — any test using this asserts the decision was made before the fallback. */
const NEVER = async (): Promise<IdleVerdict> => {
  throw new Error('the classify layer was reached when an earlier layer should have decided');
};

// ── the structural layer ─────────────────────────────────────────────────────

test('the vetoes name every structural reason this turn is work', () => {
  assert.deepEqual(idleVetoes('hey', CLEAR), [], 'a bare stall on a quiet turn clears them all');

  assert.deepEqual(idleVetoes('hey?', CLEAR), ['question_mark']);
  assert.deepEqual(idleVetoes('ok 4', CLEAR), ['digit']);
  assert.deepEqual(idleVetoes('ok example.com/x', CLEAR), ['url']);
  assert.deepEqual(idleVetoes('ok https://example.test', CLEAR), ['url']);
  assert.deepEqual(idleVetoes('ok www.example.test', CLEAR), ['url']);

  assert.deepEqual(idleVetoes('hey', facts({ attachmentNote: true })), ['attachment_note']);
  assert.deepEqual(idleVetoes('hey', facts({ burstSize: 2 })), ['burst']);
  assert.deepEqual(idleVetoes('hey', facts({ activeOps: true })), ['active_ops']);
  assert.deepEqual(idleVetoes('hey', facts({ pendingQuestion: true })), ['pending_question']);
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'yes' })), ['consent']);
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'no' })), ['consent']);
  // 'unclear' settles nothing, so it vetoes nothing — the whole point of a three-way reading.
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'unclear' })), []);
});

test('a question mark vetoes in every script a text message arrives in', () => {
  for (const mark of QUESTION_MARKS) {
    assert.deepEqual(idleVetoes(`ok${mark}`, CLEAR), ['question_mark'], `the ${mark} mark`);
  }
});

test('a digit vetoes in every script, and the length caps count what a person typed', () => {
  assert.deepEqual(idleVetoes('ok ٤', CLEAR), ['digit'], 'Arabic-Indic digits are digits');

  const seven = 'ok cool yeah sure nice thanks lol';
  assert.equal(seven.split(' ').length, IDLE_MAX_TOKENS + 1, 'the fixture is genuinely one token over');
  assert.deepEqual(idleVetoes(seven, CLEAR), ['too_many_tokens'], 'every token is an example, and it is still work');

  const long = `${'ok '.repeat(14)}ok`;
  assert.ok([...long].length > IDLE_MAX_CHARS);
  assert.ok(idleVetoes(long, CLEAR).includes('too_long'));

  // The character cap is the one that reads a script the tokenizer cannot: this message tokenizes
  // to nothing at all, so only the code-point count can see how long it is.
  const cjk = '。'.repeat(IDLE_MAX_CHARS + 1);
  assert.deepEqual(idleVetoes(cjk, CLEAR), ['too_long']);
});

test('a bare domain is left to the fallback rather than read as a link', () => {
  // "ok.thanks" is how a person types two words with no space, and a URL veto wide enough to catch
  // a bare domain is wide enough to catch that too — a stall turned into a task for nothing.
  assert.deepEqual(idleVetoes('ok.thanks', CLEAR), []);
});

test('the vetoes accumulate — the receipt is not limited to the first thing wrong', () => {
  assert.deepEqual(
    idleVetoes('did the 3 land at example.com/x?', facts({ burstSize: 3, activeOps: true })),
    ['question_mark', 'digit', 'url', 'too_many_tokens', 'burst', 'active_ops'],
  );
});

test('endsInQuestion reads her last turn in any script, through a closing quote', () => {
  assert.equal(endsInQuestion('want me to send it?'), true);
  assert.equal(endsInQuestion('送っていい？'), true);
  assert.equal(endsInQuestion('¿lo mando?'), true);
  assert.equal(endsInQuestion('so, thursday then?"'), true, 'a quoted question is still a question');
  assert.equal(endsInQuestion('sending it now.'), false);
  assert.equal(endsInQuestion('why not? sending it now.'), false, 'a mark mid-sentence is not the end');
  assert.equal(endsInQuestion(''), false);
  assert.equal(endsInQuestion(null), false);
  assert.equal(endsInQuestion(undefined), false);
});

// ── layer 1: the veto path ───────────────────────────────────────────────────

test('a veto ends the turn as work, before the fast path and before any call', async () => {
  const rows: Array<[string, IdleFacts]> = [
    ['hey?', CLEAR],                              // a question mark
    ['ok 4', CLEAR],                              // a digit
    ['ok example.com/x', CLEAR],                  // a link
    ['ok cool yeah sure nice thanks lol', CLEAR], // seven tokens, every one an example
    ['yes please', facts({ pendingQuestion: true })],
    ['sure', facts({ consent: 'yes' })],
    ['hey', facts({ attachmentNote: true })],
    ['hey', facts({ burstSize: 2 })],
    ['ok', facts({ activeOps: true })],
  ];
  for (const [text, f] of rows) {
    assert.deepEqual(await isIdleTurn(text, f, NEVER), { idle: false, layer: 'veto' }, JSON.stringify(text));
  }
});

test('"sure" is the most example-shaped token there is, and a settled yes still outranks it', async () => {
  // The precedence that matters most: the fast path would call this idle in one lookup, and the
  // consent reader has already read it as permission for something irreversible.
  assert.ok(leafTokens().has('sure'), 'the fixture is genuinely on the fast path');
  assert.deepEqual(await isIdleTurn('sure', facts({ consent: 'yes' }), NEVER), { idle: false, layer: 'veto' });
  assert.deepEqual(await isIdleTurn('sure', CLEAR, NEVER), { idle: true, layer: 'fast_path' });
});

// ── layer 2: the English fast path ───────────────────────────────────────────

test('a short message made only of examples is idle, with no call at all', async () => {
  const c = stub('ask');
  for (const text of ['im bored', 'hmm', 'same', 'ok', 'hey', 'nothing much', 'lol', 'night']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { idle: true, layer: 'fast_path' }, text);
  }
  assert.deepEqual(c.calls, [], 'the fast path is free — it never reaches the lane');
});

test('the fast path is case- and apostrophe-insensitive, the way a token is', async () => {
  for (const text of ['OK', "I'm bored", 'Hey', '  hmm  ']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, NEVER), { idle: true, layer: 'fast_path' }, text);
  }
});

test('the example set is small, lowercase and unpunctuated — a shortcut, not a lexicon', () => {
  assert.ok(LEAF_EXAMPLES.length < 60, `the list is ${LEAF_EXAMPLES.length} long; it is meant to stay small`);
  assert.equal(new Set(LEAF_EXAMPLES).size, LEAF_EXAMPLES.length, 'no token is listed twice');
  for (const token of LEAF_EXAMPLES) {
    assert.match(token, /^[a-z0-9]+$/, `${token}: a token, so it can actually match one`);
  }
  // The words a piece of work is made of are deliberately NOT in here: an example set that swallowed
  // a verb would turn a deployment into a stall.
  for (const token of ['deploy', 'prod', 'run', 'test', 'kill', 'container', 'meeting', 'moved', 'shift', 'tomorrow']) {
    assert.ok(!leafTokens().has(token), `${token}: work is never an example`);
  }
});

// ── layer 3: the injected classifier ─────────────────────────────────────────

test('work that clears the vetoes and fails the fast path goes to the classifier, and comes back task', async () => {
  const c = stub('ask');
  for (const text of ['deploy prod', 'run test', 'kill container', 'morning meeting moved', 'night shift tomorrow']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { idle: false, layer: 'classify' }, text);
  }
  assert.deepEqual(c.calls, ['deploy prod', 'run test', 'kill container', 'morning meeting moved', 'night shift tomorrow']);
});

test('a stall the English list cannot read is idle, through the classifier', async () => {
  // The 2026-09-04 rule in one test: none of these tokenizes to an example (two of them tokenize to
  // nothing at all), and every one of them is the same idle turn "hmm" is.
  const c = stub('stall');
  for (const text of ['bosan', 'sama', 'nada', 'ya', 'なんもない', 'что-то']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { idle: true, layer: 'classify' }, text);
  }
  assert.equal(c.calls.length, 6, 'one call each');
});

test('the classifier is read strictly: only the exact word stall is idle', async () => {
  for (const verdict of ['ask', 'unclear', 'STALL?', 'stalling', 'yes', '', 'stall me']) {
    const c = stub(verdict);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), { idle: false, layer: 'classify' }, JSON.stringify(verdict));
  }
  // …but the word itself survives the whitespace and capitals a lane puts on it.
  for (const verdict of ['stall', 'STALL', ' stall\n']) {
    const c = stub(verdict);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), { idle: true, layer: 'classify' }, JSON.stringify(verdict));
  }
});

test('a thrown, dead or timed-out classifier is a task, and the receipt still says it ran', async () => {
  for (const message of ['no classify lane configured', 'idle classify timed out']) {
    const c = thrower(message);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), { idle: false, layer: 'classify' }, message);
    assert.equal(c.calls.length, 1, 'it was really asked');
  }
});

test('a turn with nothing to read is a task, and no layer claims to have read it', async () => {
  for (const text of ['', '   ', '\n \t ']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, NEVER), { idle: false, layer: 'none' }, JSON.stringify(text));
  }
});

test('every layer the gate can report is a member of IDLE_LAYERS', async () => {
  const seen = new Set<string>();
  seen.add((await isIdleTurn('', CLEAR, NEVER)).layer);
  seen.add((await isIdleTurn('hey?', CLEAR, NEVER)).layer);
  seen.add((await isIdleTurn('hey', CLEAR, NEVER)).layer);
  seen.add((await isIdleTurn('bosan', CLEAR, stub('stall').fn)).layer);
  assert.deepEqual([...seen].sort(), [...IDLE_LAYERS].sort(), 'all four, and nothing else');
});

// ── the env extras ───────────────────────────────────────────────────────────

test('LEAF_EXAMPLES_EXTRA widens the fast path at call time, with no code change', async () => {
  const saved = process.env.LEAF_EXAMPLES_EXTRA;
  try {
    delete process.env.LEAF_EXAMPLES_EXTRA;
    assert.deepEqual(leafExamplesExtra(), []);
    const before = stub('ask');
    assert.deepEqual(await isIdleTurn('mkay', CLEAR, before.fn), { idle: false, layer: 'classify' }, 'unknown today');

    process.env.LEAF_EXAMPLES_EXTRA = ' MKAY , yeh ,, ';
    assert.deepEqual(leafExamplesExtra(), ['mkay', 'yeh'], 'trimmed, lowercased, blanks dropped');
    assert.ok(leafTokens().has('mkay'));
    assert.deepEqual(await isIdleTurn('mkay', CLEAR, NEVER), { idle: true, layer: 'fast_path' }, 'and read at call time');
    assert.deepEqual(await isIdleTurn('yeh mkay', CLEAR, NEVER), { idle: true, layer: 'fast_path' });

    // An extra widens the fast path and never a veto: a seven-token message of extras is still work.
    assert.deepEqual(await isIdleTurn('mkay yeh mkay yeh mkay yeh mkay', CLEAR, NEVER), { idle: false, layer: 'veto' });
  } finally {
    if (saved === undefined) delete process.env.LEAF_EXAMPLES_EXTRA;
    else process.env.LEAF_EXAMPLES_EXTRA = saved;
  }
  assert.ok(!leafTokens().has('mkay'), 'the env is restored for the rest of the file');
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the gate never mutates what it was handed', async () => {
  const f = facts({ burstSize: 3 });
  const before = JSON.stringify(f);
  idleVetoes('hey there you', f);
  await isIdleTurn('hey there you', f, NEVER);
  assert.equal(JSON.stringify(f), before);
  assert.equal(LEAF_EXAMPLES.length, new Set(LEAF_EXAMPLES).size, 'and the example list is still itself');
});

test('the gate is deterministic — the same message twice is the same answer twice', async () => {
  const c = stub('stall');
  assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), await isIdleTurn('bosan', CLEAR, c.fn));
  assert.deepEqual(idleVetoes('did the 3 land?', CLEAR), idleVetoes('did the 3 land?', CLEAR));
});
