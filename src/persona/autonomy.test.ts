// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The autonomy round (2026-09-25), pure halves only: the take turn (a question asking what SHE
// thinks), a mood's no on the envelope, what it leaves owed, what she keeps about herself, and the
// two gates on a thought she texts on her own. No lane is reached; every model is a stub.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isIdleTurn, classifyNeeded, type IdleFacts, type IdleVerdict } from './idle.js';
import { selectHook, renderHooksSection, defaultHookState, TAKE_HEADING, type HookAffectInput } from './hooks.js';
import { parseTurnedDown, coerceStatus } from './status.js';
import { foldOwedAsks, matchesOwed, raisesOwed, renderOwedSection, OWED_MAX, OWED_TTL_MS } from '../memory/owedAsks.js';
import { foldSelf, parseSelfReply, renderSelfSection, cleanSelfText, MAX_SELF_ENTRIES } from '../memory/selfHarvest.js';
import { pickSeed, weatherAllows } from '../memory/musings.js';
import { readIdleVerdict } from '../agents/convo/idleClassify.js';
import { renderDriftAnchor } from './policy.js';
import { compileAffect } from './affectCompiler.js';
import type { SelfEntry } from '../db/repositories/self.js';
import type { StoredMessage } from '../db/types.js';

const NOW = Date.UTC(2026, 8, 25, 12);

const CLEAR: IdleFacts = {
  attachmentNote: false, burstSize: 1, activeOps: false, pendingAsk: false,
  endsInQuestion: false, followUpOutstanding: false, consent: 'unclear',
};
const says = (v: IdleVerdict) => async () => v;
const OPTS = { shareTurns: true, takeTurns: true };

// ── take turns ────────────────────────────────────────────────────────────────

test('a bare question the classifier reads as her take is a task marked take', async () => {
  assert.deepEqual(await isIdleTurn('do you like horror movies?', CLEAR, says('take'), OPTS),
    { shape: 'task', layer: 'classify', signals: [], take: true });
  // Any other verdict, or a failure, is the plain task it always was.
  assert.deepEqual(await isIdleTurn('what time is it in tokyo?', CLEAR, says('ask'), OPTS),
    { shape: 'task', layer: 'classify', signals: [] });
  const boom = async (): Promise<IdleVerdict> => { throw new Error('lane down'); };
  assert.equal((await isIdleTurn('do you like cats?', CLEAR, boom, OPTS)).take, undefined);
});

test('a question with any other veto never reaches the take reading', async () => {
  let called = false;
  const spy = async (): Promise<IdleVerdict> => { called = true; return 'take'; };
  const r = await isIdleTurn('what do you think of this? https://x.com/a', CLEAR, spy, OPTS);
  assert.equal(called, false);
  assert.equal(r.layer, 'veto');
  assert.equal(r.take, undefined);
  // An answer of theirs owed is work too.
  assert.equal((await isIdleTurn('do you like it?', { ...CLEAR, pendingAsk: true }, spy, OPTS)).take, undefined);
  // And with the switch off, a question is a veto exactly as before.
  assert.deepEqual(await isIdleTurn('do you like cats?', CLEAR, spy, { shareTurns: true }), { shape: 'task', layer: 'veto', signals: [] });
  assert.equal(called, false);
});

test('the prefetch warms the classifier for a bare question only when takes are on', () => {
  assert.equal(classifyNeeded('do you like cats?', { attachmentNote: false, burstSize: 1 }, OPTS), true);
  assert.equal(classifyNeeded('do you like cats?', { attachmentNote: false, burstSize: 1 }, { shareTurns: true }), false);
  assert.equal(classifyNeeded('look at https://x.com/a?', { attachmentNote: false, burstSize: 1 }, OPTS), false);
});

test('the classifier word take reads as take', () => {
  assert.equal(readIdleVerdict('take'), 'take');
  assert.equal(readIdleVerdict('Take.'), 'take');
});

const AFFECT: HookAffectInput = {
  hooks: 'all', question: 'open', heavy: false, lateNight: false,
  playfulnessBand: 'none', lastOutcome: null, englishLooseness: 1,
};

test('a take is a task whose play dial reads her mood, and it renders its own section', () => {
  const { directive, report } = selectHook(defaultHookState(), 'task', 'classify', AFFECT, false, NOW, true);
  assert.equal(directive.mode, 'task');
  assert.equal(directive.take, true);
  assert.ok(directive.playLevel > 0, 'a take may be funny');
  assert.equal(report.reason, 'take');
  assert.ok(renderHooksSection(directive).startsWith(TAKE_HEADING));
  // A flat mood still answers the take, dry.
  const flat = selectHook(defaultHookState(), 'task', 'classify', { ...AFFECT, hooks: 'none' }, false, NOW, true);
  assert.equal(flat.directive.playLevel, 0);
  // A plain task renders nothing, as before.
  assert.equal(renderHooksSection(selectHook(defaultHookState(), 'task', 'veto', AFFECT, false, NOW).directive), '');
});

test('running on empty marks a plain task, and the recency edge states the tired law', () => {
  const spent = selectHook(defaultHookState(), 'task', 'veto', { ...AFFECT, spent: true }, false, NOW);
  assert.equal(spent.directive.spent, true);
  assert.equal(selectHook(defaultHookState(), 'task', 'veto', AFFECT, false, NOW).directive.spent, undefined);
  const law = renderDriftAnchor('spent', 0);
  assert.ok(law.includes('running on empty') && law.includes('stays owed'));
  assert.ok(law.includes('still gets answered flat'), 'a fact, a clock and their safety never wait on it');
  // The compiler reads it off a sad core or a spent battery, and nothing else.
  const computed = { cycle: { phase: 'follicular', day: 8, load: 40 }, circadian: { slot: 'afternoon', energy: 70 } } as never;
  const row = (label: string, battery = 70) => ({ mood_label: label, social_battery: battery, mood_level: 60 }) as never;
  assert.equal(compileAffect(row('drained'), computed).spent, true);
  assert.equal(compileAffect(row('playful', 20), computed).spent, true);
  assert.equal(compileAffect(row('playful'), computed).spent, false);
  assert.equal(compileAffect(undefined, computed).spent, false);
});

// ── a mood's no ───────────────────────────────────────────────────────────────

test('turned_down reads later and no, and needs the ask named', () => {
  assert.deepEqual(parseTurnedDown('later: the essay outline'), { how: 'later', ask: 'the essay outline' });
  assert.deepEqual(parseTurnedDown('No - roasting on command'), { how: 'no', ask: 'roasting on command' });
  // A bare "no" is a small model saying "nothing was turned down", never a refusal.
  assert.equal(parseTurnedDown('no'), undefined);
  assert.equal(parseTurnedDown('none'), undefined);
  assert.equal(parseTurnedDown(null), undefined);
  assert.equal(parseTurnedDown('later'), undefined);
  const s = coerceStatus({ mood_label: 'drained', turned_down: 'later: <b>flights</b> to bali' });
  assert.equal(s?.turned_down, 'later: bflights/b to bali');
});

test('a put-off is owed until it is asked for again, looked into, or stale', () => {
  const put = foldOwedAsks([], { texts: ['can you research bali flights'], turnedDown: 'later: research bali flights' }, NOW);
  assert.deepEqual(put, [{ ask: 'research bali flights', at: NOW }]);
  // An unrelated turn leaves it owed.
  assert.deepEqual(foldOwedAsks(put, { texts: ['lol ok'] }, NOW + 1000), put);
  // Their re-ask settles it; a look she hands out does too.
  assert.deepEqual(foldOwedAsks(put, { texts: ['ok now find me bali flights pls'] }, NOW + 1000), []);
  assert.deepEqual(foldOwedAsks(put, { texts: ['', 'bali flights under 300'] }, NOW + 1000), []);
  // A refusal owes nothing.
  assert.deepEqual(foldOwedAsks([], { texts: [], turnedDown: 'no: roast me again' }, NOW), []);
  // Stale ones fall off, and the store stays small.
  assert.deepEqual(foldOwedAsks(put, { texts: [] }, NOW + OWED_TTL_MS + 1), []);
  let many = put;
  const asks = ['draft the landlord email', 'compare two gaming laptops', 'plan a kyoto itinerary', 'summarize that paper'];
  for (const [i, a] of asks.entries()) many = foldOwedAsks(many, { texts: [], turnedDown: `later: ${a}` }, NOW + i);
  assert.equal(many.length, OWED_MAX);
});

test('she checks once: an owed ask is spent the moment her reply raises it', () => {
  const put = foldOwedAsks([], { texts: [], turnedDown: 'later: mechanical keyboard comparison under 100' }, NOW);
  // The not-now reply that minted it never counts as raising it.
  const minted = foldOwedAsks([], { texts: [], turnedDown: 'later: mechanical keyboard comparison under 100', raised: 'not today, the keyboard one stays owed' }, NOW);
  assert.equal(minted.length, 1);
  assert.deepEqual(foldOwedAsks(put, { texts: ['hey'], raised: 'wait u still need the keyboard thing or u sorted it?' }, NOW + 1000), []);
  // A reply about something else leaves it owed, and filler words prove nothing.
  assert.equal(foldOwedAsks(put, { texts: ['hey'], raised: 'lol that meeting sounds rough' }, NOW + 1000).length, 1);
  assert.equal(raisesOwed('mechanical keyboard comparison under 100', 'under the weather today'), false);
});

test('one shared word never settles an owed ask, and the section has no digits', () => {
  assert.equal(matchesOwed('research bali flights', 'bali is hot'), false);
  const section = renderOwedSection([{ ask: 'research bali flights', at: NOW - 86_400_000 }], NOW);
  assert.match(section, /^## /);
  assert.ok(section.includes('- research bali flights (yesterday)'));
  assert.equal(renderOwedSection([], NOW), '');
});

// ── her self ──────────────────────────────────────────────────────────────────

const WINDOW: StoredMessage[] = [
  { role: 'user', content: 'pineapple on pizza is a crime', at: NOW - 3000 },
  { role: 'assistant', content: 'nahh pineapple belongs there, sweet and salty is the whole point', at: NOW - 2000 },
  { role: 'user', content: 'my coach says sleep matters more than cardio', at: NOW - 1000 },
  { role: 'assistant', content: 'ok that one actually changed my mind', at: NOW - 500 },
];
let n = 0;
const ids = () => `n${n++}`;

test('a stance she asserted is kept; an invented one and an echo are not', () => {
  const held: SelfEntry[] = [{ id: 'a', kind: 'stance', text: 'pineapple belongs on pizza, sweet and salty is the point', at: NOW - 86_400_000 }];
  const folded = foldSelf(held, {
    entries: [
      { kind: 'stance', text: 'pineapple belongs on pizza because sweet and salty is the whole point', replaces: null },
      { kind: 'stance', text: 'astrology is actually fake and i will die on it', replaces: null },
      { kind: 'learned', text: 'from them: sleep matters more than cardio for recovery', replaces: null },
      { kind: 'mood', text: 'whatever this is', replaces: null },
    ],
    drop: [],
  }, WINDOW, NOW, ids);
  assert.deepEqual(folded.entries.map(e => e.kind).sort(), ['learned', 'stance']);
  assert.deepEqual(folded.rejected, { echo: 1, unevidenced: 1, kind: 1 });
});

test('a change of mind replaces the stance it overturns, and drops only touch what she holds', () => {
  const held: SelfEntry[] = [{ id: 'p', kind: 'stance', text: 'cardio beats sleep for getting fit', at: NOW - 86_400_000 }];
  const folded = foldSelf(held, {
    entries: [{ kind: 'changed', text: 'used to think cardio beats sleep, their coach point about recovery changed my mind', replaces: 'p' }],
    drop: ['ghost'],
  }, WINDOW, NOW, ids);
  assert.equal(folded.entries.length, 1);
  assert.equal(folded.entries[0].kind, 'changed');
  assert.equal(folded.replaced, 1);
  assert.equal(folded.dropped, 0);
});

test('the file keeps its cap, oldest out, and the section renders newest first', () => {
  const held: SelfEntry[] = Array.from({ length: MAX_SELF_ENTRIES }, (_, i) => ({ id: `h${i}`, kind: 'taste', text: `taste number ${i} about pineapple things`, at: NOW - (100 - i) * 1000 }));
  const folded = foldSelf(held, { entries: [{ kind: 'stance', text: 'sweet and salty pizza wins, the whole point', replaces: null }], drop: [] }, WINDOW, NOW, ids);
  assert.equal(folded.entries.length, MAX_SELF_ENTRIES);
  assert.equal(folded.evicted, 1);
  assert.ok(!folded.entries.some(e => e.id === 'h0'));
  const section = renderSelfSection(folded.entries);
  assert.ok(section.split('\n')[2].startsWith('- stance: sweet and salty'));
  assert.equal(renderSelfSection([]), '');
});

test('her text is one clean line with no dashes, and a reply parses by the house ladder', () => {
  assert.equal(cleanSelfText('i like it — a lot\nreally <b>'), 'i like it, a lot really b');
  assert.deepEqual(parseSelfReply('{"entries":[],"drop":[]}'), { entries: [], drop: [] });
  assert.equal(parseSelfReply('no json here'), null);
  assert.deepEqual(parseSelfReply('sure {"entries":[{"kind":"taste","text":"x"}]'), { entries: [{ kind: 'taste', text: 'x' }], drop: [] });
});

// ── her own texts ─────────────────────────────────────────────────────────────

test('a thought of hers waits for her weather and never repeats a recent seed', () => {
  assert.equal(weatherAllows(undefined), true);
  assert.equal(weatherAllows({ mood_core: 'joyful', mood_level: 80, social_battery: 70 }), true);
  assert.equal(weatherAllows({ mood_core: 'sad', mood_level: 30 }), false);
  assert.equal(weatherAllows({ mood_core: 'peaceful', mood_level: 60, social_battery: 20 }), false);
  assert.equal(pickSeed(['a', 'b'], ['a'], 0.99), 'b');
  assert.equal(pickSeed(['a'], ['a'], 0), null);
  assert.equal(pickSeed([], [], 0), null);
});
