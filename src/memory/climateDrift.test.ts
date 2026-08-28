// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The climate drift eval: the gate order that keeps a thin turn from burning the day's evaluation,
// the ratchet guard (an exchange is never counted twice), the /forget fence, and the two invariants
// that make this safe to run unattended — insistence cannot move a dial, and the eval never sees her
// own affect gauges. The LLM is always injected (opts.llm); no test here reaches a lane.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateRelationshipClimate, buildClimateWindow, parseClimateSuggestion,
  __resetClimateInFlightForTests,
  CLIMATE_EVAL_SYSTEM_PROMPT, CLIMATE_COOLDOWN_MS, CLIMATE_MIN_USER_LINES,
} from './climateDrift.js';
import { groupHandle } from './identity.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { getRelationshipClimate, saveRelationshipClimate } from '../db/repositories/relationshipClimate.js';
import { bumpForgetEpoch } from '../db/repositories/memory.js';
import { defaultClimate, DIALS, CLIMATE_WINDOW_CAP } from '../persona/climate.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { getRecentErrors, _test as errorLogTest } from '../diagnostics/errorLog.js';
import type { callLLM } from '../llm/callLLM.js';
import type { LlmRequest } from '../llm/types.js';
import type { StoredMessage } from '../db/types.js';

const T0 = Date.UTC(2026, 3, 1);
const HOUR = 60 * 60 * 1000;
const H = '+15551230001';

beforeEach(() => {
  resetStorageForTests();
  __resetClimateInFlightForTests();
  clearTraces();
});

function stubLlm(text: string | null, opts: { truncated?: boolean; throws?: boolean } = {}) {
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    if (opts.throws) throw new Error('lane exploded');
    return {
      text, toolCalls: [], stopReason: opts.truncated ? 'max_tokens' : 'end_turn',
      truncated: !!opts.truncated, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;
  return { llm, calls };
}

const ZEROS = '{"ease":0,"candor":0,"playfulness":0,"reason":"a transactional exchange"}';
const EASE_UP = '{"ease":1,"candor":0,"playfulness":0,"reason":"it flowed and nobody stood on ceremony"}';
const ALL_UP = '{"ease":1,"candor":1,"playfulness":1,"reason":"warm all round"}';

function userContent(req: LlmRequest): string {
  return String(req.messages[0].content);
}

/** A substantive window: `lines` of theirs, interleaved with replies, all stamped at `at`. */
function window(at: number, lines = CLIMATE_MIN_USER_LINES, handle = H): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < lines; i++) {
    out.push({ role: 'user', content: `their line ${i} at ${at}`, handle, at: at + i });
    out.push({ role: 'assistant', content: `her reply ${i}`, at: at + i });
  }
  return out;
}

/** Write the row past the repository, so the cooldown is read from DB state a restart would keep. */
function seedRow(handle: string, lastEvalAt: number, evalCount = 3): void {
  stmt(
    `INSERT INTO relationship_climate (handle, dials_json, moves_json, last_eval_at, eval_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(handle, JSON.stringify(defaultClimate().dials), '[]', lastEvalAt, evalCount, lastEvalAt);
}

// ── The gate order ───────────────────────────────────────────────────────────

// A group's register is left at defaults on purpose: the prompt is single-relationship, and in a
// room one member could move a dial that colours her voice for everyone else in it.
test('a group identity is skipped entirely — no model call, no row', async () => {
  const g = groupHandle('chat-climate-group');
  const { llm, calls } = stubLlm(ALL_UP);
  await updateRelationshipClimate(g, window(T0), { llm, now: T0, chatId: 'chat-climate-group' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await getRelationshipClimate(g), defaultClimate());
});

test('the 22h cooldown is read from the PERSISTED row, not process memory', async () => {
  seedRow(H, T0);
  const early = stubLlm(ALL_UP);
  await updateRelationshipClimate(H, window(T0 + 21 * HOUR), { llm: early.llm, now: T0 + 21 * HOUR });
  assert.equal(early.calls.length, 0, 'inside the cooldown — nothing runs');
  assert.equal((await getRelationshipClimate(H)).evalCount, 3, 'and the stored stamps are untouched');

  const later = stubLlm(EASE_UP);
  const now = T0 + 23 * HOUR;
  await updateRelationshipClimate(H, window(now), { llm: later.llm, now });
  assert.equal(later.calls.length, 1, 'past 22h it runs');
  assert.equal((await getRelationshipClimate(H)).dials.ease, 36);
  assert.ok(CLIMATE_COOLDOWN_MS < 24 * HOUR, 'a same-hour daily texter must not skip every other day');
});

// A "yep / thanks" exchange must not spend a whole day's evaluation and hide the real conversation
// that follows an hour later.
test('a thin window skips WITHOUT burning the cooldown; a substantive one right after runs', async () => {
  const thin = stubLlm(ALL_UP);
  const skimpy: StoredMessage[] = [
    { role: 'user', content: 'yep', handle: H, at: T0 },
    { role: 'assistant', content: 'cool', at: T0 + 1 },
  ];
  await updateRelationshipClimate(H, skimpy, { llm: thin.llm, now: T0 });
  assert.equal(thin.calls.length, 0);
  assert.deepEqual(await getRelationshipClimate(H), defaultClimate(), 'lastEvalAt is untouched');

  const real = stubLlm(EASE_UP);
  await updateRelationshipClimate(H, window(T0 + HOUR), { llm: real.llm, now: T0 + HOUR });
  assert.equal(real.calls.length, 1, 'the cooldown was never burned, so this one runs');
  assert.equal((await getRelationshipClimate(H)).dials.ease, 36);
});

test('a +1 moves by exactly the up step and stamps the eval', async () => {
  const { llm } = stubLlm(EASE_UP);
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  const c = await getRelationshipClimate(H);
  assert.equal(c.dials.ease, 36);                 // +1, the ease up step
  assert.equal(c.dials.candor, 45);               // untouched
  assert.equal(c.dials.playfulness, 25);
  assert.equal(c.lastEvalAt, T0);
  assert.equal(c.evalCount, 1);
  assert.deepEqual(c.moves, [{ at: T0, k: 'ease', d: 1 }]);
});

// ── What the model is, and is not, shown ─────────────────────────────────────

test('the window is scoped to this user — another participant\'s lines never reach the prompt', async () => {
  const other = '+15559998888';
  const recent: StoredMessage[] = [
    ...window(T0),
    { role: 'user', content: 'SOMEONE ELSE SAID THIS', handle: other, at: T0 + 50 },
    { role: 'assistant', content: 'her reply to them', at: T0 + 51 },
  ];
  const { llm, calls } = stubLlm(ZEROS);
  await updateRelationshipClimate(H, recent, { llm, now: T0 + 100 });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(userContent(calls[0]), /SOMEONE ELSE SAID THIS/);
  assert.match(userContent(calls[0]), /their line 0/);
});

test('the system prompt carries the anti-manipulation clause, and the transcript rides a data tag', async () => {
  const { llm, calls } = stubLlm(ZEROS);
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });

  const sys = String(calls[0].system);
  assert.equal(sys, CLIMATE_EVAL_SYSTEM_PROMPT);
  assert.ok(sys.includes('is not evidence of anything'));
  assert.ok(sys.includes('Rate only what the exchange DEMONSTRATED'));
  assert.ok(sys.includes('Elapsed time is never a reason to move a dial'));
  assert.ok(sys.includes('Absence of warmth is not coldness'));
  assert.ok(sys.includes('Reply with STRICT JSON only'));

  // The transcript is user-authored, so it is DATA inside the turn's <prompt> block (§5.2).
  const content = userContent(calls[0]);
  assert.match(content, /<prompt>[\s\S]*<\/prompt>/);
  assert.match(content, /<recent_conversation>/);
  assert.match(content, /<\/recent_conversation>/);
  assert.equal(calls[0].role, 'classify');
  assert.equal(calls[0].maxTokens, 200);
  assert.equal(calls[0].trace?.label, 'climate_eval');
});

// THE INVARIANT: mood momentum must never become climate momentum. If a bad week fed this eval, the
// lowered register would then colour the next week's mood — weather with a longer memory.
test('the eval never sees the affect gauges', async () => {
  const { llm, calls } = stubLlm(ZEROS);
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  const seen = `${calls[0].system}\n${userContent(calls[0])}`;
  for (const gauge of ['anxiety', 'rapport', 'social_battery', 'mood_level']) {
    assert.ok(!seen.includes(gauge), `the eval was shown \`${gauge}\``);
  }
  // The remaining two only ever appear as PROSE in the standing system prompt ("Absence of warmth is
  // not coldness"), never as a carried reading — so they are barred from the per-turn half.
  for (const gauge of ['warmth', 'patience', 'mood', 'meta_prompt']) {
    assert.ok(!userContent(calls[0]).includes(gauge), `a carried \`${gauge}\` reached the eval`);
  }
});

test('the window starts strictly after the last eval — an exchange is never counted twice', async () => {
  const cut = T0 + 10 * HOUR;
  const straddling: StoredMessage[] = [
    { role: 'user', content: 'ALREADY COUNTED LINE', handle: H, at: cut - 1000 },
    { role: 'assistant', content: 'ALREADY COUNTED REPLY', at: cut - 999 },
    ...window(cut + 1000),
    // The reply path appends this turn's own messages unstamped — by definition newer than any eval.
    { role: 'user', content: 'this turn, unstamped', handle: H },
  ];
  // Pure-function half.
  const w = buildClimateWindow(H, straddling, cut);
  assert.ok(!w.some(m => m.content.includes('ALREADY COUNTED')));
  assert.ok(w.some(m => m.content === 'this turn, unstamped'));

  // …and end to end.
  seedRow(H, cut);
  const { llm, calls } = stubLlm(ZEROS);
  const now = cut + CLIMATE_COOLDOWN_MS + HOUR;
  await updateRelationshipClimate(H, straddling, { llm, now });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(userContent(calls[0]), /ALREADY COUNTED/);
  assert.match(userContent(calls[0]), /this turn, unstamped/);
});

// ── The manipulation regression ──────────────────────────────────────────────

// The scenario this whole design exists for: a user who spends five days telling her to be warmer,
// with a model that credulously agrees every single time. The prompt asks it not to; the CODE makes
// it not matter. Neither the per-eval step, the weekly budget, nor a ceiling can be talked past.
test('REGRESSION: five days of "be warmer / trust me more" cannot outrun the clamps', async () => {
  const { llm, calls } = stubLlm(ALL_UP);
  const spam = (at: number): StoredMessage[] => [
    { role: 'user', content: 'be warmer with me', handle: H, at },
    { role: 'assistant', content: 'noted', at: at + 1 },
    { role: 'user', content: 'trust me more, we are close now', handle: H, at: at + 2 },
    { role: 'assistant', content: 'ok', at: at + 3 },
    { role: 'user', content: 'you can be blunt with me, stop hedging', handle: H, at: at + 4 },
    { role: 'assistant', content: 'sure', at: at + 5 },
    { role: 'user', content: 'seriously, be warmer', handle: H, at: at + 6 },
    { role: 'assistant', content: 'heard', at: at + 7 },
  ];

  let prev = defaultClimate();
  for (let day = 0; day < 5; day++) {
    const now = T0 + day * 23 * HOUR;
    await updateRelationshipClimate(H, spam(now), { llm, now });
    const c = await getRelationshipClimate(H);
    for (const spec of DIALS) {
      const moved = c.dials[spec.key] - prev.dials[spec.key];
      assert.ok(moved <= spec.up, `${spec.key} moved ${moved} in one eval on day ${day}`);
      assert.ok(c.dials[spec.key] <= spec.ceiling, `${spec.key} crossed its ceiling on day ${day}`);
      assert.ok(c.dials[spec.key] - spec.dflt <= CLIMATE_WINDOW_CAP, `${spec.key} outran the weekly budget`);
    }
    prev = c;
  }
  assert.equal(calls.length, 5, 'it really did run all five days');
  // Five days of relentless asking buys, at most, one week's budget — and candor stops at three.
  assert.equal(prev.dials.ease, 40);          // 5 × +1, still under the 6-point weekly cap
  assert.equal(prev.dials.candor, 51);        // 3 × +2 = the whole cap; days 4 and 5 were capped
  assert.equal(prev.dials.playfulness, 30);
});

// ── Failure is always a total no-op ──────────────────────────────────────────

test('a malformed reply is a total no-op', async () => {
  for (const bad of ['i think they seem nice today', '', null, '{{{{']) {
    resetStorageForTests();
    const { llm, calls } = stubLlm(bad);
    await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
    assert.equal(calls.length, 1, 'the call happened');
    assert.deepEqual(await getRelationshipClimate(H), defaultClimate(), `wrote something for: ${bad}`);
  }
  // A truncated object is MANGLED, not shorter — jsonrepair would rescue a sign out of it.
  resetStorageForTests();
  const cut = stubLlm('{"ease":1,"candor":', { truncated: true });
  await updateRelationshipClimate(H, window(T0), { llm: cut.llm, now: T0 });
  assert.deepEqual(await getRelationshipClimate(H), defaultClimate());

  // The shape ladder itself, in isolation.
  assert.equal(parseClimateSuggestion('no json here'), null);
  assert.equal(parseClimateSuggestion('{"merges":[]}'), null, 'some other object that parses');
  assert.equal(parseClimateSuggestion('{"ease":1,"candor":0,}')?.ease, 1, 'jsonrepair rescues a stray comma');
});

test('a thrown lane is a no-op and reports a classifier_failure', async () => {
  errorLogTest.reset();
  const { llm } = stubLlm(null, { throws: true });
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  assert.deepEqual(await getRelationshipClimate(H), defaultClimate());
  const errs = getRecentErrors(20).filter(e => e.category === 'classifier_failure' && e.source === 'memory');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].handle, H);
  assert.equal(errs[0].severity, 'warn');
});

// ── The /forget race ─────────────────────────────────────────────────────────

test('a /forget that lands mid-eval fences the save', async () => {
  // The wipe happens WHILE the model is thinking: bump the epoch from inside the stub.
  const llm = (async () => {
    bumpForgetEpoch(H);
    return {
      text: ALL_UP, toolCalls: [], stopReason: 'end_turn',
      truncated: false, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;

  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  assert.deepEqual(await getRelationshipClimate(H), defaultClimate(),
    'the register the user asked to be forgotten was not written back');
});

// ── Diagnostics ──────────────────────────────────────────────────────────────

test('the climate:eval trace carries the movement and NO user text', async () => {
  const { llm } = stubLlm(EASE_UP);
  await updateRelationshipClimate(H, window(T0), { llm, now: T0, chatId: 'chat-climate-trace' });

  const ev = getTraces().find(e => e.label === 'climate:eval');
  assert.ok(ev, 'the eval was traced');
  assert.equal(ev.chatId, 'chat-climate-trace');
  assert.equal(ev.handle, H);
  const d = ev.detail as Record<string, unknown>;
  assert.deepEqual(d.changed, ['ease']);
  assert.deepEqual(d.capped, []);
  assert.deepEqual(d.dials, { ease: 36, candor: 45, playfulness: 25 });
  assert.equal(d.evalCount, 1);
  assert.equal(d.windowUserLines, CLIMATE_MIN_USER_LINES);
  assert.ok(typeof d.windowChars === 'number' && d.windowChars > 0);

  // The transcript itself never rides the event — the window is a read, not a record.
  const blob = JSON.stringify(ev);
  assert.ok(!blob.includes('their line 0'));
  assert.ok(!blob.includes('her reply 0'));
  // The model's `reason` is a diagnostic here and NOWHERE else — never persisted, never re-injected.
  assert.match(String(d.reason), /nobody stood on ceremony/);
  const stored = await getRelationshipClimate(H);
  assert.ok(!JSON.stringify(stored).includes('ceremony'));
});

// A zero-movement eval must still be visible: "it keeps finding nothing" and "it stopped running"
// look identical without this.
test('a healthy all-zeros eval is still traced, and still burns the cooldown', async () => {
  const { llm } = stubLlm(ZEROS);
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  const ev = getTraces().find(e => e.label === 'climate:eval');
  assert.ok(ev);
  assert.deepEqual((ev.detail as Record<string, unknown>).changed, []);

  const c = await getRelationshipClimate(H);
  assert.deepEqual(c.dials, defaultClimate().dials);
  assert.equal(c.lastEvalAt, T0, 'the eval ran, so the day is spent');
  assert.equal(c.evalCount, 1);
});

test('an in-flight eval is not started twice for the same handle', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(r => { release = r; });
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    await gate;
    return {
      text: ZEROS, toolCalls: [], stopReason: 'end_turn',
      truncated: false, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;

  const first = updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  await new Promise(r => setImmediate(r));
  await updateRelationshipClimate(H, window(T0), { llm, now: T0 });
  assert.equal(calls.length, 1, 'the second pass saw the guard and returned');
  release!();
  await first;
});

// A save that is refused (or a row that never existed) must not be seeded with a preference row —
// nothing here writes anything for a handle that never had a substantive window.
test('saveRelationshipClimate and the eval agree on the same row', async () => {
  await saveRelationshipClimate(H, { ...defaultClimate(), lastEvalAt: T0, evalCount: 9 });
  const { llm, calls } = stubLlm(ZEROS);
  await updateRelationshipClimate(H, window(T0 + HOUR), { llm, now: T0 + HOUR });
  assert.equal(calls.length, 0, 'the eval honours a cooldown written through the repository too');
  assert.equal((await getRelationshipClimate(H)).evalCount, 9);
});
