// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The WIRING half of associative threading: the gate ladder, the /forget fence, and the receipt
// policy. What gets minted, offered, or refused is persona/threads.test.ts's job — everything here is
// about the plumbing around it: does the flag really cost nothing, does a room really write nothing,
// does a fenced-out write really report itself as unapplied, and does the dashboard get exactly the
// events it needs and none of the every-turn noise it doesn't.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateThreadInventory, pickThreadForTurn, __resetThreadInFlightForTests,
} from './threadHarvest.js';
import { groupHandle } from './identity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getThreadInventory, saveThreadInventory } from '../db/repositories/threadInventory.js';
import { bumpForgetEpoch } from '../db/repositories/memory.js';
import {
  defaultThreadInventory, THREAD_MIN_TURNS_BETWEEN_OFFERS, LOOP_OPENING_GAP_MS,
  type ThreadInventory, type ThreadTheme,
} from '../persona/threads.js';
import { coerceStatus, mergeStatus, type AffectState, type EmittedStatus } from '../persona/status.js';
import { computeCycle } from '../persona/cycle.js';
import { computeCircadian } from '../persona/circadian.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import type { TraceEvent } from '../diagnostics/trace.js';

const T0 = Date.UTC(2026, 3, 1);
const DAY = 24 * 60 * 60 * 1000;
const H = '+15551230009';

beforeEach(() => {
  resetStorageForTests();
  __resetThreadInFlightForTests();
  clearTraces();
});

/** A full emitted status, with whatever threading fields the case needs folded in. Built through
 *  coerceStatus so a test can never hand the harvest something the envelope couldn't produce. */
function status(extra: Record<string, unknown> = {}): EmittedStatus {
  return coerceStatus({
    mood_label: 'content', mood_shift: 'steady', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'keep it easy',
    ...extra,
  })!;
}

/** The last-turn affect record selection reads, in a shape that opens the theme gate. `mood_level`
 *  is STATED on the record rather than emitted into it — it is code's answer now (the envelope
 *  stopped carrying it), and the level selection's own floor reads has to be a decision here rather
 *  than whatever the clock happened to drift a cold gauge to. */
function affect(at: number, extra: Record<string, unknown> = {}): AffectState {
  const last = {
    ...mergeStatus(status(extra), {
      cycle: computeCycle(at, at),
      circadian: computeCircadian(at, 'UTC'),
    }, at),
    mood_level: 60,
  };
  return { last, moodHistory: [] };
}

function trace(label: string): TraceEvent | undefined {
  return getTraces().find(e => e.label === label);
}
function traces(label: string): TraceEvent[] {
  return getTraces().filter(e => e.label === label);
}
function detail(ev: TraceEvent | undefined): Record<string, unknown> {
  return (ev?.detail ?? {}) as Record<string, unknown>;
}

/** A theme that has already earned its second mention — the cheapest fixture that can be offered. */
function taggableTheme(now: number): ThreadTheme {
  return {
    id: 't1', label: 'speed vs craft', kind: 'tension',
    note: 'they keep landing back on shipping fast versus doing it right',
    evidenceDays: [1, 2], evidenceCount: 2, status: 'taggable', confidence: 45,
    firstSeenAt: now - 10 * DAY, lastSeenAt: now - DAY, lastOfferedAt: 0, lastTaggedAt: 0,
    lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0, pushbacks: 0, mintedDistressed: false,
  };
}

async function seed(handle: string, patch: Partial<ThreadInventory>): Promise<void> {
  await saveThreadInventory(handle, { ...defaultThreadInventory(), ...patch });
}

// ── The gate ladder ──────────────────────────────────────────────────────────

// CONVO_THREADING_ENABLED is the FIRST gate at BOTH ends, before the group skip and before any DB
// touch: an install that turned the feature off must not pay a read, a write, or a byte of prompt.
test('the kill switch stops the harvest AND the pre-turn read before anything is touched', async () => {
  process.env.CONVO_THREADING_ENABLED = 'false';
  try {
    await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
    assert.deepEqual(await getThreadInventory(H), defaultThreadInventory(), 'nothing was written');
    assert.equal(trace('threads:harvest'), undefined, 'and nothing was traced');

    await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: 9 });
    const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
      incomingText: 'hey', gapMs: 2 * LOOP_OPENING_GAP_MS, now: T0,
    });
    assert.deepEqual(picked, { offer: null, outcomeAsk: null }, 'an earned theme is not offered');
    assert.equal(trace('threads:select'), undefined, 'the off read is not even a no-op receipt');
  } finally {
    delete process.env.CONVO_THREADING_ENABLED;
  }
  // Unset means ON — an install that never heard of the flag keeps the feature it already had.
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
  assert.equal((await getThreadInventory(H)).themes.length, 1);
});

// Structural privacy, not tuning: a theme is one person's recurring tension and a loop is one
// person's pending thing. A room has neither.
test('a group identity is skipped at both ends — no row, no receipt, no offer', async () => {
  const g = groupHandle('chat-threads-group');
  await updateThreadInventory(g, status({ thread_note: 'tension: speed vs craft' }), {
    now: T0, chatId: 'chat-threads-group',
  });
  assert.deepEqual(await getThreadInventory(g), defaultThreadInventory());
  assert.equal(trace('threads:harvest'), undefined);

  // Even with an inventory hand-written onto the group handle, the read refuses to surface it.
  await seed(g, { themes: [taggableTheme(T0)], turnsSinceOffer: 9 });
  const picked = await pickThreadForTurn(g, affect(T0 - 60_000), {
    incomingText: 'hey', gapMs: 2 * LOOP_OPENING_GAP_MS, now: T0, chatId: 'chat-threads-group',
  });
  assert.deepEqual(picked, { offer: null, outcomeAsk: null });
  assert.equal(trace('threads:select'), undefined);
});

// ── Harvest ──────────────────────────────────────────────────────────────────

test('a theme note is folded into the row and traced with what it did', async () => {
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), {
    now: T0, chatId: 'chat-threads',
  });

  const inv = await getThreadInventory(H);
  assert.equal(inv.themes.length, 1);
  assert.equal(inv.themes[0].label, 'speed vs craft');
  assert.equal(inv.themes[0].kind, 'tension');
  assert.equal(inv.themes[0].status, 'open', 'one mention never mints a taggable theme');
  assert.equal(inv.harvestCount, 1);
  assert.equal(inv.lastHarvestAt, T0);

  const ev = trace('threads:harvest');
  assert.ok(ev, 'the harvest was traced');
  assert.equal(ev.chatId, 'chat-threads');
  assert.equal(ev.handle, H);
  const d = detail(ev);
  assert.equal(d.note, 'minted');
  assert.equal(d.outcome, 'none');
  assert.equal(d.saved, true);
  assert.equal(d.label, 'speed vs craft');
  assert.equal(d.themeCount, 1);
  assert.ok(Array.isArray(d.transitions) && (d.transitions as string[]).length > 0);
});

// A venting turn still captures — it just captures something that can only ever come back as a plain
// question. `mintedDistressed` is one of the four conditions that hold a theme at the fact rung.
test('a note captured while they are venting mints the theme as distressed', async () => {
  await updateThreadInventory(H, status({
    thread_note: 'tension: speed vs craft', intent_mode: 'venting',
  }), { now: T0 });
  assert.equal((await getThreadInventory(H)).themes[0].mintedDistressed, true);

  // …and the same note on a steady turn does not.
  resetStorageForTests();
  __resetThreadInFlightForTests();
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
  assert.equal((await getThreadInventory(H)).themes[0].mintedDistressed, false);
});

// The other half of the same gate, and the half that changed hands in the envelope shrink: a low
// mood does it regardless of mode. The level is no longer a field on the envelope, so the harvest is
// HANDED the number this turn's drift settled on (persona/affectDrift.ts) — and a caller that has
// none must read as "not low" rather than as "0", which would mint every theme distressed forever.
test('a note captured while her mood is low mints the theme as distressed too', async () => {
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0, moodLevel: 20 });
  assert.equal((await getThreadInventory(H)).themes[0].mintedDistressed, true);

  resetStorageForTests();
  __resetThreadInFlightForTests();
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0, moodLevel: 60 });
  assert.equal((await getThreadInventory(H)).themes[0].mintedDistressed, false);

  // No level at all — a turn that folded no affect record — is not a distressed turn.
  resetStorageForTests();
  __resetThreadInFlightForTests();
  await updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
  assert.equal((await getThreadInventory(H)).themes[0].mintedDistressed, false);
});

// THE RECEIPT POLICY. Every turn runs a tick, so tracing them would put an event on every single
// reply and drown the dashboard in the one shape that carries no information.
test('a bare tick still writes the row, and is deliberately NOT traced', async () => {
  await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: 1, harvestCount: 7 });

  await updateThreadInventory(H, status(), { now: T0 });
  const inv = await getThreadInventory(H);
  assert.equal(inv.turnsSinceOffer, 2, 'the tick ran');
  assert.equal(inv.harvestCount, 8);
  assert.equal(inv.lastHarvestAt, T0);
  assert.equal(trace('threads:harvest'), undefined, 'and it left no receipt');

  // A turn with NO status at all is the same tick-only path — a garbled envelope must not stop the
  // clock that ages loops and paces her budgets.
  await updateThreadInventory(H, undefined, { now: T0 + 60_000 });
  assert.equal((await getThreadInventory(H)).turnsSinceOffer, 3);
  assert.equal(trace('threads:harvest'), undefined);
});

test('an in-flight harvest is not started twice for the same handle', async () => {
  const first = updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
  const second = updateThreadInventory(H, status({ thread_note: 'goal: ship the rewrite' }), { now: T0 });
  await Promise.all([first, second]);
  assert.equal((await getThreadInventory(H)).themes.length, 1, 'the second pass saw the guard');
});

// ── The /forget race ─────────────────────────────────────────────────────────

// The wipe lands WHILE the harvest is between its epoch read and its write: the note routes, the
// theme mints, and the ONLY thing that fails is the save.
test('a /forget that lands mid-harvest fences the write, and the receipt says so', async () => {
  const running = updateThreadInventory(H, status({ thread_note: 'tension: speed vs craft' }), { now: T0 });
  bumpForgetEpoch(H);
  await running;

  assert.deepEqual(await getThreadInventory(H), defaultThreadInventory(),
    'the theme the user asked to be forgotten was not written back');
  // …and diagnostics say so, rather than showing a harvest that never landed.
  assert.equal(detail(trace('threads:harvest')).saved, false);
});

// ── Selection ────────────────────────────────────────────────────────────────

// The healthy nothing-qualified no-op IS the receipt: an inventory that keeps finding nothing to say
// and an inventory that stopped being read look identical without it.
test('a healthy no-op still records threads:select, with the disjoint filtered counts', async () => {
  await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: 0 });

  const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'what time is the standup', gapMs: 5 * 60_000, now: T0, chatId: 'chat-threads',
  });
  assert.equal(picked.offer, null);
  assert.equal(picked.outcomeAsk, null);

  const ev = trace('threads:select');
  assert.ok(ev, 'the quiet turn is still on the record');
  assert.equal(ev.handle, H);
  assert.equal(ev.chatId, 'chat-threads');
  const d = detail(ev);
  assert.equal(d.reason, 'turn_gate', 'and it says WHY it was quiet');
  assert.equal(d.turnsSinceOffer, 0);
  assert.equal(d.outcomeAsk, null);
  assert.ok(d.filtered, 'the disjoint buckets ride along');
  assert.equal(d.material, undefined, 'nothing was offered, so no material is claimed');
  // The same accounting rides BACK to the turn as well, so the turn's own receipt
  // (diagnostics/turnTrace.ts → gates.threads) carries the threading verdict instead of two records
  // having to be correlated by timestamp afterwards.
  assert.equal(picked.report?.reason, 'turn_gate');
  assert.equal(picked.report?.turnsSinceOffer, 0);
});

test('an offered theme is billed into the row and reported on the receipt', async () => {
  await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: THREAD_MIN_TURNS_BETWEEN_OFFERS + 1 });

  const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'anyway how was the weekend, still shipping fast?', gapMs: 5 * 60_000, now: T0,
  });
  assert.equal(picked.offer?.id, 't1');
  assert.equal(picked.offer?.material, 'theme');
  assert.equal(picked.offer?.rungCeiling, 'fact', 'a theme with no uptake yet is bait, never a claim');
  assert.equal(picked.outcomeAsk, null);

  // Billed on the OFFER, not on her using it — that is the whole backstop, and it only works if the
  // pre-turn read persists what it spent.
  const inv = await getThreadInventory(H);
  assert.deepEqual(inv.pending, { themeId: 't1', at: T0, phase: 'offered', material: 'theme' });
  assert.equal(inv.turnsSinceOffer, 0);
  assert.equal(inv.offers.length, 1);
  assert.equal(inv.themes[0].lastOfferedAt, T0);

  const d = detail(trace('threads:select'));
  assert.equal(d.reason, 'offered_theme');
  assert.equal(d.material, 'theme');
  assert.equal(d.rungCeiling, 'fact');
  assert.equal(d.label, 'speed vs craft');
});

// The gate that fixes off-topic drift, through the real read path — and the receipt it leaves. The
// bucket rides along for free because `pickThreadForTurn` spreads the whole ThreadSelectReport into
// the event, which is exactly why the report is the shape it is.
test('an off-topic theme is not offered, and threads:select names the new bucket', async () => {
  await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: THREAD_MIN_TURNS_BETWEEN_OFFERS + 1 });

  const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'what time is the standup tomorrow', gapMs: 5 * 60_000, now: T0,
  });
  assert.equal(picked.offer, null);
  assert.equal(picked.outcomeAsk, null);

  const d = detail(trace('threads:select'));
  assert.equal(d.reason, 'no_eligible');
  assert.equal((d.filtered as { themes: { off_topic: number } }).themes.off_topic, 1);
  assert.equal(picked.report?.filtered.themes.off_topic, 1, 'and the bucket reaches the turn too');
  // Nothing was billed, so the theme is still there for the turn that IS about it.
  assert.equal((await getThreadInventory(H)).themes[0].lastOfferedAt, 0);
});

// CONVO_THEME_TOPIC_GATE is the narrower switch inside CONVO_THREADING_ENABLED: threading stays on,
// the topicality filter comes off, and the same off-topic theme is offered exactly as it was before
// the gate existed.
test('CONVO_THEME_TOPIC_GATE=false restores the pre-gate selection', async () => {
  process.env.CONVO_THEME_TOPIC_GATE = 'false';
  try {
    await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: THREAD_MIN_TURNS_BETWEEN_OFFERS + 1 });
    const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
      incomingText: 'what time is the standup tomorrow', gapMs: 5 * 60_000, now: T0,
    });
    assert.equal(picked.offer?.id, 't1');
    const d = detail(trace('threads:select'));
    assert.equal(d.reason, 'offered_theme');
    assert.equal((d.filtered as { themes: { off_topic: number } }).themes.off_topic, 0);
  } finally {
    delete process.env.CONVO_THEME_TOPIC_GATE;
  }
});

// The turn AFTER an offer: the pending slot has been walked to `awaiting` by that turn's harvest, so
// the ask renders and selection stands down globally (one thing in flight, across both materials).
test('an awaiting pending renders the outcome ask and blocks a new offer', async () => {
  await seed(H, {
    themes: [taggableTheme(T0)],
    pending: { themeId: 't1', at: T0 - 60_000, phase: 'awaiting', material: 'theme' },
    turnsSinceOffer: 9,
  });

  const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'yeah maybe', gapMs: 60_000, now: T0,
  });
  assert.equal(picked.offer, null);
  assert.deepEqual(picked.outcomeAsk, { label: 'speed vs craft', material: 'theme' });
  assert.equal(detail(trace('threads:select')).reason, 'awaiting_outcome');
  assert.equal(detail(trace('threads:select')).outcomeAsk, 'theme');
});

// A pending id whose theme was evicted, retired, or pruned must not become a question about a thread
// that no longer exists.
test('an awaiting pending whose thread has vanished renders nothing', async () => {
  await seed(H, {
    themes: [],
    pending: { themeId: 'gone', at: T0 - 60_000, phase: 'awaiting', material: 'theme' },
  });
  const picked = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'hey', gapMs: 60_000, now: T0,
  });
  assert.equal(picked.offer, null);
  assert.equal(picked.outcomeAsk, null, 'no question about a thread that no longer exists');
  assert.equal(traces('threads:select').length, 1, 'the run is still on the record');
});

// The full loop across the seam: the read offers and bills, the harvest walks the pending slot to
// `awaiting`, the NEXT read asks about it, and the harvest after that consumes the answer.
test('offer → harvest → ask → outcome walks the pending slot end to end', async () => {
  await seed(H, { themes: [taggableTheme(T0)], turnsSinceOffer: THREAD_MIN_TURNS_BETWEEN_OFFERS + 1 });

  const first = await pickThreadForTurn(H, affect(T0 - 60_000), {
    incomingText: 'anyway how was the weekend, still shipping fast?', gapMs: 5 * 60_000, now: T0,
  });
  assert.ok(first.offer);

  await updateThreadInventory(H, status(), { now: T0 + 1000 });
  assert.equal((await getThreadInventory(H)).pending?.phase, 'awaiting');

  const second = await pickThreadForTurn(H, affect(T0), {
    incomingText: 'ha, yeah, that is basically it', gapMs: 60_000, now: T0 + 2000,
  });
  assert.deepEqual(second.outcomeAsk, { label: 'speed vs craft', material: 'theme' });

  await updateThreadInventory(H, status({ thread_outcome: 'took' }), { now: T0 + 3000 });
  const inv = await getThreadInventory(H);
  assert.equal(inv.pending, null, 'the slot is clear again');
  assert.equal(inv.themes[0].uptakes, 1);
  assert.equal(inv.themes[0].lastOutcome, 'took');
  assert.equal(detail(traces('threads:harvest').at(-1)).outcome, 'took');
});
