// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The moments engine: the arithmetic that turns a night's proposals into a file, and a file into the
// two-to-five moments one idle turn is allowed to see. These tests pin the invariants the rest of
// the feature leans on:
//
//   • DISJOINT REPORT. Every proposal handed to `foldHarvest` lands in exactly one bucket, so the
//     `moments:harvest` receipt can never say two things at once about one proposal.
//   • MERGE UP, INTO THE OLDER ID. A repeat is a count on the row that has been carrying the
//     pattern, with the newer text and a refreshed date — never a second row. The one exception is
//     pinned too: a fold that only containment matched keeps the LONGER text, so a fragment cannot
//     truncate a moment nothing archives.
//   • PRUNE DELETES. Decayed rows leave the returned array and go nowhere else. There is no archive
//     in this file and no test here that looks for one.
//   • REPLAYABLE. Same entries, same `now`, same seed → the same offer, forever. A sampler that
//     cannot be replayed cannot be scored by the battery.
//   • NOT ONE DIGIT in a rendered line's format, and no date anywhere in it.
//   • PURE. `now` is injected and every input is deep-frozen here, so a mutation is a test failure.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMENT_TAGS, MAX_MOMENTS, MOMENT_TEXT_MAX, MOMENT_DECAY_MS, MOMENT_RECENT_EXCLUDE_MS,
  MOMENT_OLD_MS, MOMENT_SAMPLE_RECENT, MOMENT_SAMPLE_OLD, MOMENT_MERGE_SIM, MOMENT_FOLD_MAX_NEW,
  MOMENT_AGE_WORDS, mulberry32, sampleMoments, momentAgeWords, renderMomentLines, foldHarvest,
  pruneMoments, billOffers,
  type MomentEntry, type MomentProposal,
} from './moments.js';

const T0 = Date.UTC(2026, 3, 1);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;

/** A moment, `daysAgo` old, with everything boring filled in. Frozen: every function here is pure,
 *  and a `TypeError` from a stray assignment is the cheapest possible purity test. */
function moment(over: Partial<MomentEntry> & { daysAgo?: number } = {}): MomentEntry {
  const { daysAgo, ...rest } = over;
  return Object.freeze({
    id: rest.id ?? `m${seq++}`,
    text: rest.text ?? 'they checked the volcano again',
    tag: rest.tag ?? 'habit',
    at: rest.at ?? T0 - (daysAgo ?? 0) * DAY,
    count: rest.count ?? 1,
    offered: rest.offered ?? 0,
    lastOfferedAt: rest.lastOfferedAt ?? 0,
  }) as MomentEntry;
}

const NONE: ReadonlySet<string> = new Set<string>();

// ── The constants the store and the battery re-export ────────────────────────────────────────────

test('the constants are the documented numbers, and the tag set is closed', () => {
  assert.deepEqual([...MOMENT_TAGS], ['habit', 'obsession', 'embarrassing']);
  assert.equal(MAX_MOMENTS, 40);
  assert.equal(MOMENT_TEXT_MAX, 200);
  assert.equal(MOMENT_DECAY_MS, 60 * DAY);
  assert.equal(MOMENT_RECENT_EXCLUDE_MS, DAY);
  assert.equal(MOMENT_OLD_MS, 14 * DAY);
  assert.equal(MOMENT_SAMPLE_RECENT, 3);
  assert.equal(MOMENT_SAMPLE_OLD, 2);
  assert.equal(MOMENT_MERGE_SIM, 0.5);
  assert.equal(MOMENT_FOLD_MAX_NEW, 3);
});

// ── The PRNG ─────────────────────────────────────────────────────────────────────────────────────

test('mulberry32 is deterministic per seed, in range, and differs across seeds', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const first = Array.from({ length: 8 }, () => a());
  assert.deepEqual(Array.from({ length: 8 }, () => b()), first);
  for (const v of first) {
    assert.ok(v >= 0 && v < 1, `${v} out of range`);
  }
  const c = mulberry32(8);
  assert.notDeepEqual(Array.from({ length: 8 }, () => c()), first);
  // A garbage seed still yields a usable stream rather than NaNs.
  const d = mulberry32(Number.NaN);
  assert.ok(d() >= 0 && d() < 1);
});

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────

test('a sample is at most three recent plus two old, and never repeats an id', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => moment({ id: `r${i}`, daysAgo: i })),
    ...Array.from({ length: 6 }, (_, i) => moment({ id: `o${i}`, daysAgo: 30 + i })),
  ];
  for (let seed = 0; seed < 40; seed++) {
    const picked = sampleMoments(entries, T0, NONE, seed);
    assert.equal(picked.length, MOMENT_SAMPLE_RECENT + MOMENT_SAMPLE_OLD);
    assert.equal(new Set(picked.map(e => e.id)).size, picked.length, 'no id twice');
    // The last two came from the old pool by construction.
    for (const e of picked.slice(MOMENT_SAMPLE_RECENT)) {
      assert.ok(T0 - e.at > MOMENT_OLD_MS, `${e.id} is not old enough for the second half`);
    }
  }
});

test('same seed → the same offer; a different seed generally moves it', () => {
  const entries = Array.from({ length: 10 }, (_, i) => moment({ id: `m${i}`, daysAgo: i * 4 }));
  const ids = (seed: number) => sampleMoments(entries, T0, NONE, seed).map(e => e.id);
  assert.deepEqual(ids(99), ids(99));
  assert.deepEqual(ids(99), ids(99), 'and again — no hidden state between calls');
  const distinct = new Set(Array.from({ length: 20 }, (_, s) => ids(s).join(',')));
  assert.ok(distinct.size > 1, 'the seed has to actually steer the draw');
});

test('recency is weighted, not sorted: today dominates, two months ago is still reachable', () => {
  const entries = [moment({ id: 'fresh', daysAgo: 0 }), moment({ id: 'stale', daysAgo: 59 })];
  let fresh = 0;
  let stale = 0;
  for (let seed = 0; seed < 200; seed++) {
    // One draw only, so the weights are visible: three draws would take both entries every time.
    const first = sampleMoments(entries, T0, NONE, seed)[0];
    if (first.id === 'fresh') fresh++;
    else stale++;
  }
  assert.ok(fresh > stale * 5, `weight 1 vs 1/60 should be lopsided (${fresh} vs ${stale})`);
  assert.ok(stale > 0, 'a harmonic weight never reaches zero — the old one must still come up');
});

test('excludeIds and the 24-hour stamp both hold a moment back', () => {
  const entries = [
    moment({ id: 'keep', daysAgo: 1 }),
    moment({ id: 'caller-vetoed', daysAgo: 1 }),
    moment({ id: 'just-used', daysAgo: 1, offered: 2, lastOfferedAt: T0 - DAY / 2 }),
    moment({ id: 'used-long-ago', daysAgo: 1, offered: 2, lastOfferedAt: T0 - 3 * DAY }),
  ];
  for (let seed = 0; seed < 20; seed++) {
    const ids = sampleMoments(entries, T0, new Set(['caller-vetoed']), seed).map(e => e.id);
    assert.ok(!ids.includes('caller-vetoed'), 'the caller veto is honoured');
    assert.ok(!ids.includes('just-used'), 'offered inside the no-repeat window');
    assert.deepEqual([...ids].sort(), ['keep', 'used-long-ago']);
  }
  // Exactly at the boundary the moment is available again — the window is exclusive.
  const atBoundary = [moment({ id: 'edge', daysAgo: 1, offered: 1, lastOfferedAt: T0 - MOMENT_RECENT_EXCLUDE_MS })];
  assert.deepEqual(sampleMoments(atBoundary, T0, NONE, 1).map(e => e.id), ['edge']);
});

test('an empty or fully-vetoed file samples nothing, and a small file samples what it has', () => {
  assert.deepEqual(sampleMoments([], T0, NONE, 1), []);
  const one = [moment({ id: 'only', daysAgo: 2 })];
  assert.deepEqual(sampleMoments(one, T0, new Set(['only']), 1), []);
  assert.deepEqual(sampleMoments(one, T0, NONE, 1).map(e => e.id), ['only']);
  // Nothing old enough for the second half → the offer is just the recent draws.
  const recentOnly = Array.from({ length: 4 }, (_, i) => moment({ id: `r${i}`, daysAgo: i }));
  assert.equal(sampleMoments(recentOnly, T0, NONE, 3).length, MOMENT_SAMPLE_RECENT);
});

test('a future stamp is sampled as today rather than sorting ahead of everything', () => {
  const entries = [moment({ id: 'future', at: T0 + 5 * DAY }), moment({ id: 'now', daysAgo: 0 })];
  const picked = sampleMoments(entries, T0, NONE, 5);
  assert.equal(picked.length, 2);
});

// ── Age in words ─────────────────────────────────────────────────────────────────────────────────

test('every age word is digit-free, and the bands climb', () => {
  for (const w of MOMENT_AGE_WORDS) {
    assert.doesNotMatch(w, /\d/, `"${w}" carries a digit`);
  }
  const at = (daysAgo: number) => momentAgeWords(T0 - daysAgo * DAY, T0);
  assert.equal(at(0), 'today');
  assert.equal(at(0.4), 'today');
  assert.equal(at(1), 'yesterday');
  assert.equal(at(1.9), 'yesterday');
  assert.equal(at(2), 'a few days ago');
  assert.equal(at(6), 'a few days ago');
  assert.equal(at(7), 'last week');
  assert.equal(at(13), 'last week');
  assert.equal(at(14), 'a few weeks ago');
  assert.equal(at(34), 'a few weeks ago');
  assert.equal(at(35), 'a month or two ago');
  assert.equal(at(74), 'a month or two ago');
  assert.equal(at(75), 'a while back');
  assert.equal(at(400), 'a while back');
  // A future stamp is today, like everywhere else in the engine.
  assert.equal(momentAgeWords(T0 + 10 * DAY, T0), 'today');
  // Whatever the age, the word is one of the seven — nothing is ever formatted ad hoc.
  for (let d = 0; d < 500; d++) {
    assert.ok((MOMENT_AGE_WORDS as readonly string[]).includes(at(d)));
  }
});

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

test('a rendered line is tag, age in words, then her text — and carries no digit of its own', () => {
  const sample = [
    moment({ id: 'a', tag: 'habit', daysAgo: 0, text: 'checked the volcano before checking the deploy' }),
    moment({ id: 'b', tag: 'obsession', daysAgo: 20, text: 'twenty minutes on one ad, then asked how i knew' }),
    moment({ id: 'c', tag: 'embarrassing', daysAgo: 90, text: 'called the cat by their own name, twice' }),
  ];
  const lines = renderMomentLines(sample, T0);
  assert.deepEqual(lines, [
    '- (habit, today) checked the volcano before checking the deploy',
    '- (obsession, a few weeks ago) twenty minutes on one ad, then asked how i knew',
    '- (embarrassing, a while back) called the cat by their own name, twice',
  ]);
  // The FORMAT carries no digit: strip her prose and nothing numeric is left. (Her own text may —
  // it is her words for their week, and the no-digit law is a law about the machinery.)
  for (const line of lines) {
    const format = line.replace(/\)[\s\S]*$/, ')');
    assert.doesNotMatch(format, /\d/, format);
  }
  // No date, ever: not the stamp, not a year, not an ISO fragment.
  for (const line of lines) {
    assert.doesNotMatch(line, /20\d\d|T\d\d:/);
  }
});

test('rendering collapses whitespace, drops an empty text, and never mutates the entries', () => {
  const sample = [
    moment({ id: 'a', text: '  two   lines\nof   moment  ' }),
    moment({ id: 'b', text: '   ' }),
  ];
  assert.deepEqual(renderMomentLines(sample, T0), ['- (habit, today) two lines of moment']);
  assert.equal(sample[0].text, '  two   lines\nof   moment  ', 'the entry is untouched');
  assert.deepEqual(renderMomentLines([], T0), []);
});

// ── Folding ──────────────────────────────────────────────────────────────────────────────────────

let idSeq = 0;
const ids = () => `new-${idSeq++}`;

function fold(entries: readonly MomentEntry[], proposed: MomentProposal[], now = T0) {
  return foldHarvest(entries, proposed, now, { newId: ids });
}

test('new proposals become entries with fresh ids, count one and nothing offered', () => {
  const { entries, report } = fold([], [
    { text: 'checks the volcano before the deploy', tag: 'habit' },
    { text: 'went deep on train timetables for a week', tag: 'obsession' },
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => [e.text, e.tag, e.count, e.offered, e.lastOfferedAt, e.at]), [
    ['checks the volcano before the deploy', 'habit', 1, 0, 0, T0],
    ['went deep on train timetables for a week', 'obsession', 1, 0, 0, T0],
  ]);
  assert.equal(new Set(entries.map(e => e.id)).size, 2, 'ids are distinct');
  assert.deepEqual(report, { merged: 0, added: 2, rejected_text: 0, rejected_tag: 0, rejected_cap: 0, evicted: 0 });
});

test('a writer-marked merge folds into the OLDER id: count up, new text, date refreshed', () => {
  const older = moment({ id: 'old', daysAgo: 30, text: 'checked the volcano', count: 2, offered: 1, lastOfferedAt: T0 - 40 * DAY });
  const newer = moment({ id: 'newer', daysAgo: 3, text: 'checked the volcano again', tag: 'obsession' });
  const { entries, report } = fold([newer, older], [
    { text: 'third volcano check this month', tag: 'embarrassing', merges: ['newer', 'old'] },
  ]);
  assert.equal(entries.length, 2, 'nothing was added');
  const kept = entries.find(e => e.id === 'old')!;
  assert.equal(kept.text, 'third volcano check this month', 'the newer wording is the pattern');
  assert.equal(kept.count, 3);
  assert.equal(kept.at, T0, 'a pattern is dated by the last time it happened');
  assert.equal(kept.tag, 'habit', 'the surviving row keeps its own tag');
  assert.equal(kept.offered, 1, 'and its offer history');
  assert.equal(kept.lastOfferedAt, T0 - 40 * DAY, 'folding is not using');
  assert.deepEqual(entries.find(e => e.id === 'newer'), newer, 'the other claimed id is untouched');
  assert.equal(report.merged, 1);
  assert.equal(report.added, 0);
});

test('a merges claim about an unknown id falls through to similarity rather than failing', () => {
  const existing = moment({ id: 'old', daysAgo: 10, text: 'checks the volcano before the deploy' });
  const { entries, report } = fold([existing], [
    { text: 'checks the volcano before every deploy', tag: 'habit', merges: ['deleted-last-night'] },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'old');
  assert.equal(entries[0].count, 2);
  assert.equal(report.merged, 1);
});

test('similarity folds a near-repeat and leaves an unrelated episode alone', () => {
  const existing = moment({ id: 'volcano', daysAgo: 10, text: 'checks the volcano webcam before the deploy' });
  const { entries, report } = fold([existing], [
    { text: 'checks the volcano webcam before every deploy again', tag: 'habit' },
    { text: 'argued with a barista about oat milk temperature', tag: 'embarrassing' },
  ]);
  assert.equal(report.merged, 1);
  assert.equal(report.added, 1);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'volcano');
  assert.equal(entries[0].count, 2);
  assert.match(entries[1].text, /barista/);
});

test('a containment-only fold keeps the longer text; jaccard and the writer may still reword', () => {
  const rich = 'spent twenty minutes at midnight making me identify a girl in an ad then asked how i knew';
  const existing = moment({ id: 'rich', daysAgo: 10, text: rich });

  // Short inside long — the loose leg of the match. The fragment folds; the prose survives, because
  // a merge with nothing archived behind it must not be able to truncate the best line in the file.
  const one = fold([existing], [{ text: 'asked how i knew', tag: 'habit' }]);
  assert.equal(one.report.merged, 1);
  assert.equal(one.entries[0].text, rich, 'the richest moment is not reduced to its last clause');
  assert.equal(one.entries[0].count, 2);

  // Long around short — the same rule, running the other way: the richer wording comes in.
  const two = fold([moment({ id: 'thin', daysAgo: 10, text: 'asked how i knew' })], [{ text: rich, tag: 'habit' }]);
  assert.equal(two.report.merged, 1);
  assert.equal(two.entries[0].text, rich);

  // The writer saw both texts, so its own merge claim IS trusted to shorten one.
  const three = fold([existing], [{ text: 'asked how i knew', tag: 'habit', merges: ['rich'] }]);
  assert.equal(three.entries[0].text, 'asked how i knew');
  assert.equal(three.entries[0].count, 2);

  // And so is a jaccard match, where the two texts really are the same shape said twice.
  const four = fold(
    [moment({ id: 'v', daysAgo: 10, text: 'checked the volcano webcam twice before the deploy' })],
    [{ text: 'checked the volcano webcam before deploy', tag: 'habit' }],
  );
  assert.equal(four.report.merged, 1);
  assert.equal(four.entries[0].text, 'checked the volcano webcam before deploy');
});

test('two near-identical proposals in one night collapse into one row with a count of two', () => {
  const { entries, report } = fold([], [
    { text: 'went deep on train timetables for a week', tag: 'obsession' },
    { text: 'went deep on the train timetables again for a week', tag: 'obsession' },
  ]);
  assert.equal(entries.length, 1, 'the second proposal found the first one');
  assert.equal(entries[0].count, 2);
  assert.equal(report.added, 1);
  assert.equal(report.merged, 1);
});

test('every proposal lands in exactly one bucket, and the buckets sum to what was handed in', () => {
  const existing = moment({ id: 'old', daysAgo: 5, text: 'checks the volcano webcam before the deploy' });
  const proposed: MomentProposal[] = [
    { text: 'checks the volcano webcam before the deploy, again', tag: 'habit' },   // merged
    { text: 'argued with a barista about oat milk', tag: 'embarrassing' },          // added
    { text: 'renamed the router after a fish', tag: 'habit' },                      // added
    { text: 'read the entire changelog out loud', tag: 'obsession' },               // added
    { text: 'alphabetised the spice rack at midnight', tag: 'habit' },              // rejected_cap
    { text: '   ', tag: 'habit' },                                                  // rejected_text
    { text: 'x'.repeat(MOMENT_TEXT_MAX + 1), tag: 'habit' },                        // rejected_text
    { text: 'a fine episode with a nonsense tag', tag: 'hilarious' },               // rejected_tag
    { text: 'a fine episode with an empty tag', tag: '' },                          // rejected_tag
  ];
  const { entries, report } = fold([existing], proposed);
  assert.deepEqual(report, { merged: 1, added: 3, rejected_text: 2, rejected_tag: 2, rejected_cap: 1, evicted: 0 });
  const buckets = report.merged + report.added + report.rejected_text + report.rejected_tag + report.rejected_cap;
  assert.equal(buckets, proposed.length, 'the five buckets are disjoint and total');
  assert.equal(entries.length, 4);
});

test('text is judged after whitespace collapse, and the cap is inclusive', () => {
  const long = 'y'.repeat(MOMENT_TEXT_MAX);
  const { entries, report } = fold([], [
    { text: `  ${long}  `, tag: 'habit' },
    { text: 'TAGS are read case-insensitively', tag: '  Habit ' },
  ]);
  assert.equal(report.added, 2);
  assert.equal(entries[0].text, long, 'exactly at the cap is allowed, trimmed');
  assert.equal(entries[1].tag, 'habit');
});

test('the per-fold new cap is three, and merges are not counted against it', () => {
  const existing = moment({ id: 'old', daysAgo: 5, text: 'checks the volcano webcam before the deploy' });
  const { entries, report } = fold([existing], [
    { text: 'checks the volcano webcam before the deploy once more', tag: 'habit' },
    { text: 'alphabetised the spice rack', tag: 'habit' },
    { text: 'renamed the router after a fish', tag: 'habit' },
    { text: 'read the changelog out loud', tag: 'obsession' },
    { text: 'built a spreadsheet for one decision', tag: 'obsession' },
  ]);
  assert.equal(report.merged, 1);
  assert.equal(report.added, MOMENT_FOLD_MAX_NEW);
  assert.equal(report.rejected_cap, 1);
  assert.equal(entries.length, 1 + MOMENT_FOLD_MAX_NEW);
});

test('the active cap evicts oldest-first and reports how many left', () => {
  // A full file of unmergeable moments (distinct words, so nothing folds).
  const existing = Array.from({ length: MAX_MOMENTS }, (_, i) =>
    moment({ id: `e${i}`, daysAgo: MAX_MOMENTS - i, text: `episode number ${i} about topic${i}` }));
  const { entries, report } = fold(existing, [
    { text: 'brand new unrelated flamingo incident', tag: 'embarrassing' },
    { text: 'entirely separate karaoke miscalculation', tag: 'embarrassing' },
  ]);
  assert.equal(entries.length, MAX_MOMENTS);
  assert.equal(report.added, 2);
  assert.equal(report.evicted, 2);
  const ids = entries.map(e => e.id);
  assert.ok(!ids.includes('e0'), 'the oldest went');
  assert.ok(!ids.includes('e1'));
  assert.ok(ids.includes('e2'), 'and nothing younger did');
  assert.equal(entries.filter(e => e.at === T0).length, 2, 'both new moments survived the cap');
});

test('foldHarvest never mutates its inputs and needs no id source when nothing is added', () => {
  const existing = [moment({ id: 'old', daysAgo: 5, text: 'checks the volcano webcam before the deploy' })];
  const proposed: MomentProposal[] = [{ text: 'checks the volcano webcam before the deploy again', tag: 'habit' }];
  Object.freeze(proposed);
  // No `newId` seam at all: the default is only reached when something is actually added.
  const { entries } = foldHarvest(existing, proposed, T0);
  assert.equal(entries[0].count, 2);
  assert.equal(existing[0].count, 1, 'the caller row is untouched');
  assert.notEqual(entries[0], existing[0], 'and it is a copy, not the same object');
  // The default id source does produce a distinct id when one IS needed.
  const added = foldHarvest([], [{ text: 'a brand new episode entirely', tag: 'habit' }], T0).entries;
  assert.equal(added.length, 1);
  assert.ok(added[0].id.length > 0);
});

test('an empty proposal list is an empty report and the same entries', () => {
  const existing = [moment({ id: 'a', daysAgo: 1 }), moment({ id: 'b', daysAgo: 2 })];
  const { entries, report } = fold(existing, []);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b']);
  assert.deepEqual(report, { merged: 0, added: 0, rejected_text: 0, rejected_tag: 0, rejected_cap: 0, evicted: 0 });
});

// ── Prune (deletion) ─────────────────────────────────────────────────────────────────────────────

test('prune DELETES an unused moment past the window and keeps everything inside it', () => {
  const entries = [
    moment({ id: 'young-unused', daysAgo: 59 }),
    moment({ id: 'old-unused', daysAgo: 61 }),
    moment({ id: 'at-the-boundary', at: T0 - MOMENT_DECAY_MS }),
  ];
  assert.deepEqual(pruneMoments(entries, T0).map(e => e.id), ['young-unused', 'at-the-boundary']);
});

test('an offered moment decays on its offer stamp, not on its date', () => {
  const entries = [
    // Written a year ago, used last week: live material.
    moment({ id: 'still-used', daysAgo: 365, offered: 4, lastOfferedAt: T0 - 7 * DAY }),
    // Written last week, used once two months ago: the stamp is what decides.
    moment({ id: 'gone-quiet', daysAgo: 7, offered: 1, lastOfferedAt: T0 - 61 * DAY }),
    // Offered, stamp exactly at the boundary: kept, the window is inclusive.
    moment({ id: 'boundary', daysAgo: 90, offered: 1, lastOfferedAt: T0 - MOMENT_DECAY_MS }),
  ];
  assert.deepEqual(pruneMoments(entries, T0).map(e => e.id), ['still-used', 'boundary']);
});

test('an offer count with no stamp is read as never offered, not as an ancient one', () => {
  // Exactly the row a hand-mangled `last_offered=` produces: the store degrades each annotation
  // attribute independently, so `offered` survives while the stamp is gone. Branching on the counter
  // would then read `now - 0`, put the row past every window, and delete it — in the one tier here
  // with no archive to get it back from.
  const entries = [
    moment({ id: 'stampless', daysAgo: 1, offered: 3, lastOfferedAt: 0 }),
    moment({ id: 'stampless-and-old', daysAgo: 61, offered: 3, lastOfferedAt: 0 }),
    moment({ id: 'negative-stamp', daysAgo: 1, offered: 3, lastOfferedAt: -1 }),
  ];
  assert.deepEqual(pruneMoments(entries, T0).map(e => e.id), ['stampless', 'negative-stamp']);
});

test('prune is pure, and returns a plain array with nothing archived anywhere', () => {
  const entries = [moment({ id: 'keep', daysAgo: 1 }), moment({ id: 'drop', daysAgo: 200 })];
  const out = pruneMoments(entries, T0);
  assert.equal(entries.length, 2, 'the input is untouched');
  assert.equal(out.length, 1);
  assert.equal(out[0], entries[0], 'survivors are the caller rows, unmodified');
  assert.deepEqual(pruneMoments([], T0), []);
});

// ── Billing ──────────────────────────────────────────────────────────────────────────────────────

test('billOffers counts the offer and stamps it; unbilled rows come back unchanged', () => {
  const entries = [
    moment({ id: 'a', daysAgo: 1, offered: 2, lastOfferedAt: T0 - 5 * DAY }),
    moment({ id: 'b', daysAgo: 1 }),
  ];
  const out = billOffers(entries, new Set(['a', 'not-in-the-file']), T0);
  assert.deepEqual(out.map(e => [e.id, e.offered, e.lastOfferedAt]), [
    ['a', 3, T0],
    ['b', 0, 0],
  ]);
  assert.equal(entries[0].offered, 2, 'the caller row is untouched');
  assert.notEqual(out[1], entries[1], 'every row comes back by value');
  assert.deepEqual(billOffers(entries, new Set(), T0).map(e => e.offered), [2, 0]);
});

test('a billed moment is out of the next sample for a day, and back after it', () => {
  const entries = [moment({ id: 'a', daysAgo: 2 }), moment({ id: 'b', daysAgo: 2 })];
  const billed = billOffers(entries, new Set(['a']), T0);
  for (let seed = 0; seed < 10; seed++) {
    assert.deepEqual(sampleMoments(billed, T0 + DAY / 2, NONE, seed).map(e => e.id), ['b']);
    assert.equal(sampleMoments(billed, T0 + 2 * DAY, NONE, seed).length, 2);
  }
});
