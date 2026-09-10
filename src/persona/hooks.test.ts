// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The hook engine is the CODE half of the idle-turn law: the model contributes one word out of
// three, and every run, cap, interval and veto below it is arithmetic in hooks.ts. These tests pin
// all of it, plus the invariants the rest of pillar three leans on:
//
//   • THE KILL SWITCH OUTRANKS EVERYTHING. Three hooked replies in a row and the fourth turn is
//     quiet whatever the mood, the room, or the sampler would have said. It is checked before any
//     of them, and its receipt says so in its own disjoint bucket.
//   • `none` IS AN ENTRY, not a gap. One flat reply anywhere in the window buys the next hook back,
//     which is what keeps the window three turns wide instead of three weeks wide.
//   • DISJOINT REPORTS. Every turn the selector ran lands in exactly one `reason`, and a kind that
//     is forbidden for three overlapping reasons is still named exactly once.
//   • TASK TURNS RENDER NOTHING. On the turns that are actually work the prompt is byte-identical
//     to an install that never had a hook engine.
//   • NOT ONE DIGIT, and the clamp is always last.
//   • PURE. `now` is injected, inputs are deep-frozen here and must survive it.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectHook, recordHook, quietViolation, renderHooksSection, defaultHookState, hookKindOpen,
  HOOK_WORDS, HOOK_RUN_LIMIT, MOMENT_IDLE_INTERVAL, QUIET_MAX_WORDS,
  HOOK_CLAMP, HOOK_HEADING, HOOK_LEAD, HOOK_OPEN_LINE, HOOK_NONE_OPEN, HOOK_LATE_LINE,
  MOMENTS_LEAD, QUIET_HEADING, QUIET_LAW,
  type HookAffectInput, type HookDirective, type HookKind, type HookState, type HookWord,
} from './hooks.js';

const T0 = Date.UTC(2026, 3, 1);

function state(over: Partial<HookState> = {}): HookState {
  return { ...defaultHookState(), ...over };
}

const OPEN: HookAffectInput = { hooks: 'all', lateNight: false };

/** Selection with the boring arguments filled in: an idle turn, a wide-open mood, a one-to-one chat. */
function pick(
  s: HookState,
  over: { idle?: boolean; layer?: string; affect?: HookAffectInput; isGroup?: boolean } = {},
) {
  return selectHook(
    s,
    over.idle ?? true,
    over.layer ?? 'fast_path',
    over.affect ?? OPEN,
    over.isGroup ?? false,
    T0,
  );
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ══ 1. The three modes ═══════════════════════════════════════════════════════

test('a task turn carries no hook, no offer and no moment, and says why', () => {
  const { directive, report } = pick(state({ idleSinceMoment: 99 }), { idle: false, layer: 'veto' });
  assert.equal(directive.mode, 'task');
  assert.equal(directive.idle, false);
  assert.equal(directive.offerAllowed, false);
  assert.equal(directive.moments, false, 'a spent interval buys nothing on a turn that was work');
  assert.deepEqual(directive.forbidden, [], 'the MODE forbids every kind; the list would be a second answer');
  assert.equal(report.reason, 'not_idle');
  assert.equal(report.idleLayer, 'veto', 'the layer that decided rides through untouched');
});

test('an idle turn with an empty ledger opens all three kinds', () => {
  const { directive, report } = pick(state());
  assert.equal(directive.mode, 'hook');
  assert.equal(directive.idle, true);
  assert.equal(directive.offerAllowed, true);
  assert.deepEqual(directive.forbidden, []);
  assert.equal(report.reason, 'hook');
  assert.deepEqual(report.lastKinds, []);
});

// THE load-bearing rule. Three sharp replies in a row and the fourth turn is quiet — no hook, no
// thread offer, no moment, nothing billed.
test('three hooked replies in a row force the fourth turn quiet', () => {
  const { directive, report } = pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }));
  assert.equal(directive.mode, 'quiet');
  assert.equal(directive.offerAllowed, false, 'the thread OFFER is off too — nothing is billed on a quiet turn');
  assert.equal(directive.moments, false);
  assert.deepEqual(directive.forbidden, []);
  assert.equal(report.reason, 'kill_switch');
  assert.deepEqual(report.lastKinds, ['judgment', 'callback', 'tangent'], 'the receipt shows the run it fired on');
});

// `none` is a first-class entry: one flat reply anywhere in the window breaks the run. Without it
// the window would span every hooked turn ever taken rather than the last three turns.
test('one flat reply anywhere in the window breaks the run', () => {
  for (const window of [
    ['none', 'callback', 'tangent'],
    ['judgment', 'none', 'tangent'],
    ['judgment', 'callback', 'none'],
  ] as HookKind[][]) {
    const { directive } = pick(state({ lastKinds: window }));
    assert.equal(directive.mode, 'hook', `${window.join(',')} is not a run`);
  }
});

test('a short ledger cannot fire the switch, and a long one is read at its tail', () => {
  assert.equal(pick(state({ lastKinds: ['judgment', 'callback'] })).directive.mode, 'hook',
    'two is not a run — the switch needs a full window');
  // A hand-built (or hand-edited) state longer than the cap is read exactly as the store would have
  // capped it: the tail is the run, and the older entries are already spent.
  const long: HookKind[] = ['judgment', 'callback', 'none', 'judgment', 'tangent', 'callback'];
  const { directive, report } = pick(state({ lastKinds: long }));
  assert.equal(directive.mode, 'quiet');
  assert.deepEqual(report.lastKinds, ['judgment', 'tangent', 'callback'], 'only the window the cap keeps');
});

test('a flat mood closes hooks outright, in its own bucket', () => {
  const { directive, report } = pick(state(), { affect: { hooks: 'none', lateNight: false } });
  assert.equal(directive.mode, 'quiet');
  assert.equal(directive.offerAllowed, false);
  assert.equal(report.reason, 'affect_floor');
});

// Precedence, stated as a test rather than as a comment: when both would fire, the receipt says
// kill_switch. The battery scores the switch off that bucket, so a flat mood must never be able to
// wear its name.
test('the kill switch outranks the affect floor, the room and a spent moment interval', () => {
  const { directive, report } = pick(
    state({ lastKinds: ['judgment', 'judgment', 'judgment'], idleSinceMoment: 99 }),
    { affect: { hooks: 'none', lateNight: true }, isGroup: true, layer: 'classify' },
  );
  assert.equal(directive.mode, 'quiet');
  assert.equal(directive.moments, false);
  assert.equal(report.reason, 'kill_switch');
  assert.equal(report.idleLayer, 'classify');
});

// ══ 2. Forbidden kinds ═══════════════════════════════════════════════════════

test('the same kind twice in a row forbids the third', () => {
  for (const w of HOOK_WORDS) {
    const { directive, report } = pick(state({ lastKinds: ['none', w, w] }));
    assert.equal(directive.mode, 'hook', 'a repeat is a forbidden kind, never a quiet turn');
    assert.deepEqual(directive.forbidden, [w]);
    assert.deepEqual(report.forbidden, [w], 'the receipt carries the same list');
  }
  // Two of the same kind NOT adjacent is not a tic.
  assert.deepEqual(pick(state({ lastKinds: ['judgment', 'none', 'judgment'] })).directive.forbidden, []);
  // And two flat replies in a row is just a conversation, not a repeated kind.
  assert.deepEqual(pick(state({ lastKinds: ['tangent', 'none', 'none'] })).directive.forbidden, []);
});

test('the compiled mood forbids its own kind', () => {
  assert.deepEqual(pick(state(), { affect: { hooks: 'no_judgment', lateNight: false } }).directive.forbidden, ['judgment']);
  assert.deepEqual(pick(state(), { affect: { hooks: 'no_tangent', lateNight: false } }).directive.forbidden, ['tangent']);
  assert.deepEqual(pick(state(), { affect: { hooks: 'all', lateNight: false } }).directive.forbidden, []);
});

// A read is between the two of them. In a room there is no `them` for it to be about, so the
// verdict-with-an-audience is off the table while the other two kinds stay.
test('a group forbids judgment and keeps the rest', () => {
  const { directive } = pick(state(), { isGroup: true });
  assert.equal(directive.mode, 'hook');
  assert.deepEqual(directive.forbidden, ['judgment']);
});

// Rooms accumulate a ledger exactly like a one-to-one chat does — the write sits outside the
// non-group guard for this reason.
test('the kill switch fires in a group too', () => {
  const { directive, report } = pick(state({ lastKinds: ['callback', 'tangent', 'callback'] }), { isGroup: true });
  assert.equal(directive.mode, 'quiet');
  assert.equal(report.reason, 'kill_switch');
});

test('overlapping reasons name a kind once, in HOOK_WORDS order', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'judgment', 'judgment'] }),
    { affect: { hooks: 'no_judgment', lateNight: false }, isGroup: true },
  );
  assert.deepEqual(directive.forbidden, ['judgment'], 'three reasons, one entry');

  const { directive: two } = pick(
    state({ lastKinds: ['none', 'tangent', 'tangent'] }),
    { affect: { hooks: 'no_judgment', lateNight: false } },
  );
  assert.deepEqual(two.forbidden, ['judgment', 'tangent'], 'always the array order, never the discovery order');
});

// Reachable, and rarely: a room (no judgment), a flattened mood (no tangent), and a callback she
// just used twice. The turn stays a hook turn — a thread offer still belongs to it — with nothing
// left to carry.
test('every kind can be spoken for at once, and the turn is still a hook turn', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'callback', 'callback'] }),
    { affect: { hooks: 'no_tangent', lateNight: false }, isGroup: true },
  );
  assert.equal(directive.mode, 'hook');
  assert.equal(directive.offerAllowed, true);
  assert.deepEqual(directive.forbidden, ['judgment', 'callback', 'tangent']);
});

// ══ 3. The late-night register and moments ═══════════════════════════════════

// Passed through in every mode so a consumer never has to check which branch it came from.
test('lateNight rides through every mode untouched', () => {
  const late: HookAffectInput = { hooks: 'all', lateNight: true };
  assert.equal(pick(state(), { affect: late }).directive.lateNight, true);
  assert.equal(pick(state(), { affect: late, idle: false }).directive.lateNight, true);
  assert.equal(pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }), { affect: late }).directive.lateNight, true);
  assert.equal(pick(state(), { affect: { hooks: 'all', lateNight: false } }).directive.lateNight, false);
});

// THE 2AM TURN, and the one line it used to print every night. The clock used to CLOSE every kind
// and shut the sampler and the thread offer, which left sending them to bed as the only content a
// late turn could hold — a script, restated in seven prompt surfaces, and the person on the other
// end got it every night with their name attached. The hour is a REGISTER now: it lowers the volume
// (the rendered late line) and decides nothing else, so a late idle turn falls through to the
// ordinary hook path and the mood, the room and the ledger pick the content the way they do at noon.
test('a late-night idle turn is an ordinary hook turn at a lower volume', () => {
  const late: HookAffectInput = { hooks: 'all', lateNight: true };
  const { directive, report } = pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 }), { affect: late });
  assert.equal(directive.mode, 'hook');
  assert.deepEqual(directive.forbidden, [], 'the clock closes no kind');
  assert.equal(directive.lateNight, true);
  assert.equal(directive.moments, true, 'the interval was spent, and the hour does not shut the sampler');
  assert.equal(directive.offerAllowed, true, 'nor the thread offer');
  assert.equal(report.reason, 'hook', 'the clock has no bucket of its own — there is nothing to explain');
  assert.deepEqual(report.forbidden, []);
  assert.equal(hookKindOpen(directive), true, 'so the beat is open and the anchor gets the HOOK law');
  // Byte-identical to the same state in daylight, apart from the flag itself: proof the hour is a
  // register and not a branch.
  const day = pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 }), { affect: OPEN });
  assert.deepEqual({ ...directive, lateNight: false }, day.directive);
  assert.deepEqual(report, day.report);
});

// The predicate every consumer outside the renderer has to use, and the reason it exists: the mode
// and "is there a beat" come apart on the closed-kinds shape — a room, a flattened mood and a
// repeated kind overlapping. A directive like that read as a hook turn by the climate span would put
// "A tangent or a callback is expected of you here" in the same prompt as "No kind is open this
// turn", which is the register door left open one function away.
test('hookKindOpen answers whether a beat is OPEN, never what the mode says', () => {
  const hook: HookDirective = {
    idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: true, offerAllowed: true,
  };
  assert.equal(hookKindOpen(hook), true, 'all three open');
  // Any ONE kind left is still a beat she may spend, so the boundary is the whole set and not a
  // count: a room forbids judgment and a flat mood forbids a tangent, and a callback is still a hook.
  for (const w of HOOK_WORDS) {
    assert.equal(hookKindOpen({ ...hook, forbidden: HOOK_WORDS.filter(k => k !== w) }), true, w);
  }
  assert.equal(hookKindOpen({ ...hook, forbidden: [...HOOK_WORDS] }), false, 'the closed-kinds shape');
  // Which is why the reading is taken over the SET and not off `forbidden.length`: a list that
  // carries a duplicate has HOOK_WORDS.length entries and still leaves a kind open. The renderer
  // always read the set (`allowed.length > 0`), so a counting predicate would have called this turn
  // closed while the section it ships names tangent — the disagreement this predicate exists to end.
  const dupe: HookDirective = { ...hook, forbidden: ['judgment', 'judgment', 'callback'] };
  assert.equal(dupe.forbidden.length, HOOK_WORDS.length, 'the shape that fools a count');
  assert.equal(hookKindOpen(dupe), true, 'tangent is still open');
  assert.equal(
    renderHooksSection(dupe),
    renderHooksSection({ ...hook, forbidden: ['judgment', 'callback'] }),
    'and the renderer agrees — the same section as the deduped directive, naming tangent',
  );
  // The other two modes never populate `forbidden` — the MODE forbade every kind already — so the
  // predicate must not read an empty list there as "everything is open".
  assert.equal(hookKindOpen({ ...hook, mode: 'quiet', forbidden: [] }), false);
  assert.equal(hookKindOpen({ ...hook, mode: 'task', idle: false, forbidden: [] }), false);
  // A caller with no rhythm engine at all (the flag off, a non-Convo lane) is on a turn with no beat.
  assert.equal(hookKindOpen(null), false);
  assert.equal(hookKindOpen(undefined), false);
});

// The two forced-quiet buckets are unmoved by the hour: they fire at 2am exactly as they fire at
// noon, and the receipt names the thing that actually decided. A run of three is still a run of
// three after midnight, and the clock never gets to talk one of them out of firing.
test('the kill switch and the affect floor still fire at night', () => {
  const late: HookAffectInput = { hooks: 'all', lateNight: true };
  const killed = pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }), { affect: late });
  assert.equal(killed.directive.mode, 'quiet');
  assert.equal(killed.report.reason, 'kill_switch');
  const floored = pick(state(), { affect: { hooks: 'none', lateNight: true } });
  assert.equal(floored.directive.mode, 'quiet');
  assert.equal(floored.report.reason, 'affect_floor');
});

// A late TASK turn is a task turn. Somebody who asks for something at 2am gets the answer, flat,
// with the real numbers — the clock only ever spends the extra beat, never the work.
test('the clock never touches a task turn', () => {
  const { directive, report } = pick(state(), { affect: { hooks: 'all', lateNight: true }, idle: false });
  assert.equal(directive.mode, 'task');
  assert.deepEqual(directive.forbidden, [], 'the MODE forbids every kind already');
  assert.equal(report.reason, 'not_idle');
});

// The rendered section for that turn, char-for-char: the OPEN line naming all three kinds, then the
// register line under it. Nothing in the block tells her what to send, and the word "sleep" is not
// in it — the whole complaint that produced this design was one sentence arriving every night.
test('a late idle turn renders the open line and the late line, and says nothing about sleep', () => {
  const { directive } = pick(state(), { affect: { hooks: 'all', lateNight: true } });
  assert.equal(renderHooksSection(directive), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback or a tangent. One of them, never two, never a kind not named here, and said as a statement, never asked.',
    'It is late where they are: one short bubble, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('moments wait out the interval', () => {
  for (let i = 0; i < MOMENT_IDLE_INTERVAL; i++) {
    assert.equal(pick(state({ idleSinceMoment: i })).directive.moments, false, `${i} idle turns is not enough`);
  }
  assert.equal(pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL })).directive.moments, true);
  assert.equal(pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 })).directive.moments, true);
});

// A moment can only ride out as a callback, so a forbidden callback makes the sample dead weight —
// and sampling BILLS the moment, so the gate has to sit before it, not in the renderer.
test('a forbidden callback stops the sampler even with the interval spent', () => {
  const spent = { idleSinceMoment: MOMENT_IDLE_INTERVAL + 1 };
  assert.equal(pick(state({ ...spent, lastKinds: ['none', 'callback', 'callback'] })).directive.moments, false);
  assert.equal(pick(state({ ...spent, lastKinds: ['none', 'judgment', 'judgment'] })).directive.moments, true,
    'a forbidden judgment costs the moment nothing');
});

test('a group never samples moments', () => {
  const s = state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 1 });
  assert.equal(pick(s, { isGroup: true }).directive.moments, false);
  assert.equal(pick(s).directive.moments, true);
});

// ══ 4. The ledger ════════════════════════════════════════════════════════════

test('recordHook pushes the emitted kind and caps the window', () => {
  let s = defaultHookState();
  s = recordHook(s, 'judgment', true, false, T0);
  s = recordHook(s, 'callback', true, false, T0 + 1);
  s = recordHook(s, 'tangent', true, false, T0 + 2);
  assert.deepEqual(s.lastKinds, ['judgment', 'callback', 'tangent']);
  s = recordHook(s, undefined, true, false, T0 + 3);
  assert.deepEqual(s.lastKinds, ['callback', 'tangent', 'none'], 'oldest out, most recent last, capped');
  assert.equal(s.lastKinds.length, HOOK_RUN_LIMIT);
  assert.equal(s.updatedAt, T0 + 3, 'the injected clock, never the wall clock');
});

// A droppable envelope field: a model that said nothing about its hook did not hook.
test('an absent kind reads as none', () => {
  assert.deepEqual(recordHook(defaultHookState(), undefined, true, false, T0).lastKinds, ['none']);
  assert.deepEqual(recordHook(defaultHookState(), 'nonsense' as never, true, false, T0).lastKinds, ['none'],
    'a word outside the three is no kind at all');
});

test('the idle streak counts consecutive idle turns and a real ask resets it', () => {
  let s = recordHook(defaultHookState(), 'judgment', true, false, T0);
  assert.equal(s.idleStreak, 1);
  s = recordHook(s, undefined, true, false, T0 + 1);
  assert.equal(s.idleStreak, 2);
  s = recordHook(s, undefined, false, false, T0 + 2);
  assert.equal(s.idleStreak, 0, 'one real ask and the streak is over');
  s = recordHook(s, undefined, true, false, T0 + 3);
  assert.equal(s.idleStreak, 1);
});

test('the moment clock ticks on idle turns and resets on an offer', () => {
  let s = defaultHookState();
  s = recordHook(s, undefined, true, false, T0);
  s = recordHook(s, undefined, true, false, T0 + 1);
  assert.equal(s.idleSinceMoment, 2);
  s = recordHook(s, undefined, false, false, T0 + 2);
  assert.equal(s.idleSinceMoment, 2, 'a task turn neither spends nor tops up the moment clock');
  s = recordHook(s, 'callback', true, true, T0 + 3);
  assert.equal(s.idleSinceMoment, 0, 'the offer was made, so the spacing starts again');
  assert.equal(s.idleStreak, 1, 'and the two clocks are independent — the task turn reset only one of them');
  // The reset wins on a task turn too: the offer happened either way.
  s = recordHook(s, undefined, true, false, T0 + 4);
  assert.equal(s.idleSinceMoment, 1);
  s = recordHook(s, undefined, false, true, T0 + 5);
  assert.equal(s.idleSinceMoment, 0);
});

// ══ 5. The quiet law ═════════════════════════════════════════════════════════

test('quietViolation catches a hook, a second bubble, and a long one', () => {
  const short = ['fair'];
  assert.equal(quietViolation(undefined, short), false);
  for (const w of HOOK_WORDS) {
    assert.equal(quietViolation(w, short), true, `${w} on a quiet turn is a violation`);
  }
  assert.equal(quietViolation(undefined, ['fair', 'or dont']), true, 'more than one bubble');
  const atCap = Array.from({ length: QUIET_MAX_WORDS }, (_, i) => `w${i}`).join(' ');
  assert.equal(quietViolation(undefined, [atCap]), false, 'the cap itself is fine');
  assert.equal(quietViolation(undefined, [`${atCap} more`]), true, 'one word past it is not');
  // Whitespace is not words: a padded short line is still a short line.
  assert.equal(quietViolation(undefined, ['  fair\n\n  ']), false);
  // Silence and a bare tapback are both legal quiet replies, and neither sends a bubble.
  assert.equal(quietViolation(undefined, []), false);
  assert.equal(quietViolation(undefined, ['']), false);
});

// ══ 6. The rendered section ══════════════════════════════════════════════════

const HOOK_DIRECTIVE: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: false, offerAllowed: true,
};

// THE no-regression pin: on the turns that are actually work the block is not merely short, it is
// absent — the prompt is byte-identical to an install that never had a hook engine.
test('a task turn renders not one byte', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, idle: false, mode: 'task', offerAllowed: false }), '');
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'task' }, ['a moment']), '');
});

test('the hook block renders char-for-char', () => {
  assert.equal(renderHooksSection(HOOK_DIRECTIVE), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback or a tangent. One of them, never two, never a kind not named here, and said as a statement, never asked.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// The other two variants of the hook block, char-for-char, so all nine pasted constants are pinned
// to a literal somewhere in this file rather than to themselves. `includes(CONSTANT)` is a tautology
// over the constant's own value: it proves the renderer used the constant and says nothing at all
// about whether the constant still matches the staging prose. threads.test.ts pins every rendered
// block this way and this file is written to that precedent.
test('the every-kind-spoken-for block, with the late line, renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: [...HOOK_WORDS], lateNight: true }), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'No kind is open this turn. Short and flat, and let the beat pass.',
    'It is late where they are: one short bubble, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('the moments block renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['the volcano week']), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback or a tangent. One of them, never two, never a kind not named here, and said as a statement, never asked.',
    'Kept about them, in case a callback fits. Retell one in fresh words, never read it out, never its date, never more than one.',
    'the volcano week',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('only the ALLOWED kinds are named — what is off the table is never spoken', () => {
  const one = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: ['judgment', 'tangent'] });
  assert.match(one, /^Open to you this turn: a callback\. /m);
  const two = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: ['judgment'] });
  assert.match(two, /^Open to you this turn: a callback or a tangent\. /m);
  assert.doesNotMatch(two, /judgment/, 'naming what is forbidden is an instruction to think about it');
  const none = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: [...HOOK_WORDS] });
  assert.ok(none.includes(HOOK_NONE_OPEN), 'every kind spoken for still renders a block');
  assert.doesNotMatch(none, /judgment|callback|tangent/);
});

test('the late line rides along on a hook turn, and the quiet block never needs it', () => {
  const late = renderHooksSection({ ...HOOK_DIRECTIVE, lateNight: true });
  assert.ok(late.includes(HOOK_LATE_LINE));
  assert.ok(late.includes(HOOK_OPEN_LINE.replace('{kinds}', 'a judgment, a callback or a tangent')),
    'the register line rides UNDER the open line — it does not replace it');
  assert.ok(late.endsWith(HOOK_CLAMP), 'the clamp stays last');
  const quiet = renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'quiet', lateNight: true, offerAllowed: false });
  assert.equal(quiet.includes(HOOK_LATE_LINE), false, 'a quiet turn is already the quiet reply');
  // The whole point of the redesign: no rendered shape of this section tells her to send them to bed.
  for (const mode of ['hook', 'quiet'] as const) {
    for (const lateNight of [false, true]) {
      const block = renderHooksSection({ ...HOOK_DIRECTIVE, mode, lateNight, moments: false });
      assert.doesNotMatch(block, /sleep/i, `${mode}/${lateNight} named sleep`);
    }
  }
});

test('the quiet block renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'quiet', offerAllowed: false }), [
    '## This turn is quiet (INTERNAL)',
    'Three sharp things in a row already, or your weather says so. One plain short bubble, or a tapback, or nothing — no hook, no question, no offer. Do not explain the quiet.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// The DIRECTIVE gates the moments, not the caller: one gate, in one place, and it is the one the
// receipt reports.
test('moments render only when the directive allowed them', () => {
  const lines = ['the volcano week', 'the shed that never got built'];
  const on = renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, lines);
  assert.ok(on.includes(MOMENTS_LEAD));
  for (const l of lines) assert.ok(on.includes(l));
  assert.ok(on.endsWith(HOOK_CLAMP), 'the clamp is last even with moments in the block');

  const off = renderHooksSection({ ...HOOK_DIRECTIVE, moments: false }, lines);
  assert.equal(off.includes(MOMENTS_LEAD), false);
  for (const l of lines) assert.equal(off.includes(l), false, 'a sample handed in against the gate is dropped');

  // No moments to sample is not an empty heading with nothing under it.
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['', '   ']).includes(MOMENTS_LEAD), false);
});

// A number in the prompt is a thing to reason about and optimize; a register is a thing to speak in.
// (Moment lines are model-authored prose and legitimately carry digits — their own words for their
// own week — so the pin is on the consts, and on a render with nothing interpolated.)
test('not one digit anywhere in the prose consts', () => {
  const consts = {
    HOOK_CLAMP, HOOK_HEADING, HOOK_LEAD, HOOK_OPEN_LINE, HOOK_NONE_OPEN, HOOK_LATE_LINE,
    MOMENTS_LEAD, QUIET_HEADING, QUIET_LAW,
  };
  for (const [name, line] of Object.entries(consts)) {
    assert.doesNotMatch(line, /\d/, `${name} leaked a number into the prompt`);
    assert.doesNotMatch(line, /streak|ledger|kill switch|idle turns since/i, `${name} named an internal counter`);
  }
  const forbiddenSets: HookWord[][] = [[], ['judgment'], [...HOOK_WORDS]];
  for (const forbidden of forbiddenSets) {
    for (const lateNight of [false, true]) {
      for (const mode of ['hook', 'quiet'] as const) {
        const block = renderHooksSection({ ...HOOK_DIRECTIVE, mode, forbidden, lateNight, moments: true });
        assert.doesNotMatch(block, /\d/, `${mode} block leaked a number`);
        // Every block ends on the same clamp: the one unrecoverable failure of this feature is her
        // telling someone she keeps notes on them, or that something told her what to say.
        assert.ok(block.endsWith(HOOK_CLAMP), 'the clamp is always last');
      }
    }
  }
  // A moment carrying digits still renders them: the sampler, not the prose, is the guard.
  const withDigits = renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['the 3am deploy']);
  assert.match(withDigits, /the 3am deploy/);
});

// ══ 7. Purity ════════════════════════════════════════════════════════════════

test('selectHook and recordHook are pure: frozen inputs survive, same in same out', () => {
  const before = deepFreeze(state({ lastKinds: ['none', 'judgment', 'judgment'], idleStreak: 3, idleSinceMoment: 9 }));
  const a = pick(before, { affect: { hooks: 'no_tangent', lateNight: true } });
  const b = pick(before, { affect: { hooks: 'no_tangent', lateNight: true } });
  assert.deepEqual(a.directive, b.directive);
  assert.deepEqual(a.report, b.report);
  assert.notEqual(a.report.lastKinds, before.lastKinds, 'the receipt gets its own array');

  const next = recordHook(before, 'callback', true, true, T0 + 10);
  assert.deepEqual(next.lastKinds, ['judgment', 'judgment', 'callback']);
  assert.deepEqual(before.lastKinds, ['none', 'judgment', 'judgment'], 'the input was not touched');
  assert.equal(before.idleSinceMoment, 9);
});
