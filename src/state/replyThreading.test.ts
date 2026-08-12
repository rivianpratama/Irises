process.env.TZ = 'UTC';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/replyThreading.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripReplyTag, parseReplyTag, resolveOutboundBubbles, resolveReactionTarget } from './replyThreading.js';

test('stripReplyTag: leaves clean text untouched and is idempotent', () => {
  assert.equal(stripReplyTag('comps land around $310k'), 'comps land around $310k');
  assert.equal(stripReplyTag(''), '');
  const once = stripReplyTag('[[re:1]] hi there');
  assert.equal(once, 'hi there');
  assert.equal(stripReplyTag(once), once); // idempotent
});

test('stripReplyTag: strips a leading tag without harming an adjacent range/currency', () => {
  assert.equal(stripReplyTag('[[re:1]] 3-5 weeks'), '3-5 weeks');
  assert.equal(stripReplyTag('[[re:2]] $1,800-$2,000/mo'), '$1,800-$2,000/mo');
  assert.equal(stripReplyTag('[[re:1]] 10%-12% range'), '10%-12% range');
});

test('stripReplyTag: a tag-only bubble strips to empty; malformed tags are still scrubbed', () => {
  assert.equal(stripReplyTag('[[re:1]]'), '');
  assert.equal(stripReplyTag('[[re:none]] hi'), 'hi'); // backstop catches the non-digit shape
  assert.equal(stripReplyTag('mid [[re:3]] bubble'), 'mid bubble'); // stray mid-text tag
});

test('stripReplyTag: does not mistake a URL or bracketed text for a tag', () => {
  assert.equal(stripReplyTag('https://x.co/c?foo=1&bar=2'), 'https://x.co/c?foo=1&bar=2');
  assert.equal(stripReplyTag('[bracketed] note here'), '[bracketed] note here');
});

test('parseReplyTag: reads a leading index and returns clean text', () => {
  assert.deepEqual(parseReplyTag('[[re:2]] owner is the trust'), { index: 2, text: 'owner is the trust' });
  assert.deepEqual(parseReplyTag('no tag here'), { index: null, text: 'no tag here' });
  assert.deepEqual(parseReplyTag('[[re:none]] still stripped'), { index: null, text: 'still stripped' });
  assert.deepEqual(parseReplyTag('[[re:1]]'), { index: 1, text: '' });
});

test('resolveOutboundBubbles: single message, no tap → clean, unthreaded (tags ignored + stripped)', () => {
  const r = resolveOutboundBubbles(['[[re:1]] comps land around $310k', 'want the breakdown?'], ['m1'], { isBurst: false });
  assert.deepEqual(r.bubbles, ['comps land around $310k', 'want the breakdown?']);
  assert.deepEqual(r.targets, [undefined, undefined]);
});

test('resolveOutboundBubbles: single message, anchorFirstTo (tapped or gapped) → anchors ONLY the first bubble', () => {
  const anchor = { message_id: 'inbound-1' };
  const r = resolveOutboundBubbles(['on the option period, yeah', "you've got til friday"], ['inbound-1'], { isBurst: false, anchorFirstTo: anchor });
  assert.deepEqual(r.targets, [anchor, undefined]); // quote once to anchor, then flow
});

test('resolveOutboundBubbles: single message, no anchor → clean (nothing to connect)', () => {
  const r = resolveOutboundBubbles(['3% on $400k is $12k', 'want your split on that?'], ['inbound-1'], { isBurst: false });
  assert.deepEqual(r.targets, [undefined, undefined]);
});

test('resolveOutboundBubbles: burst, every bubble tagged → each threads to its own message', () => {
  const r = resolveOutboundBubbles(['[[re:1]] comps land around $310k', '[[re:2]] owner is the delgado trust'], ['m1', 'm2'], { isBurst: true });
  assert.deepEqual(r.bubbles, ['comps land around $310k', 'owner is the delgado trust']);
  assert.deepEqual(r.targets, [{ message_id: 'm1' }, { message_id: 'm2' }]);
});

test('resolveOutboundBubbles: burst, an untagged bubble sends clean (only tagged bubbles quote)', () => {
  const r = resolveOutboundBubbles(['[[re:1]] on it', 'pulling that now'], ['m1', 'm2'], { isBurst: true });
  assert.deepEqual(r.targets, [{ message_id: 'm1' }, undefined]); // 2nd untagged → no quote, just flows
});

test('resolveOutboundBubbles: burst, out-of-range / [0] index → no quote (never a bogus id)', () => {
  const r = resolveOutboundBubbles(['[[re:5]] a', '[[re:0]] b'], ['m1', 'm2'], { isBurst: true });
  assert.deepEqual(r.targets, [undefined, undefined]); // unresolvable indices never produce a bogus id
});

test('resolveOutboundBubbles: burst, tags drive quoting; anchorFirstTo is not used as a fallback', () => {
  const anchor = { message_id: 'anchor' };
  const r = resolveOutboundBubbles(['[[re:1]] tagged', 'untagged'], ['m1', 'm2'], { isBurst: true, anchorFirstTo: anchor });
  assert.deepEqual(r.targets, [{ message_id: 'm1' }, undefined]); // tagged → m1; untagged → clean
});

test('resolveOutboundBubbles: own-line tag carries onto the next content bubble (no silent misfire)', () => {
  // The model put the tag on its own line, so splitIntoBubbles separated it: ['[[re:1]]', 'comps...'].
  const r = resolveOutboundBubbles(['[[re:1]]', 'comps land around $310k'], ['m1', 'm2'], { isBurst: true });
  assert.deepEqual(r.bubbles, ['comps land around $310k']); // tag-only segment dropped
  assert.deepEqual(r.targets, [{ message_id: 'm1' }]);       // its index carried forward
});

test('resolveOutboundBubbles: duplicate tag index → both bubbles thread to that message', () => {
  const r = resolveOutboundBubbles(['[[re:2]] first part', '[[re:2]] second part'], ['m1', 'm2'], { isBurst: true });
  assert.deepEqual(r.targets, [{ message_id: 'm2' }, { message_id: 'm2' }]);
});

// ── resolveReactionTarget (react to a specific [msg N], else the latest) ───────

test('resolveReactionTarget: a valid 1-based index maps to that message id', () => {
  assert.equal(resolveReactionTarget(1, ['m1', 'm2', 'm3'], 'last'), 'm1');
  assert.equal(resolveReactionTarget(2, ['m1', 'm2', 'm3'], 'last'), 'm2');
  assert.equal(resolveReactionTarget(3, ['m1', 'm2', 'm3'], 'last'), 'm3');
});

test('resolveReactionTarget: absent / non-positive / out-of-range → fallback (today\'s behavior)', () => {
  const ids = ['m1', 'm2'];
  assert.equal(resolveReactionTarget(undefined, ids, 'last'), 'last');
  assert.equal(resolveReactionTarget(null, ids, 'last'), 'last');
  assert.equal(resolveReactionTarget(0, ids, 'last'), 'last');
  assert.equal(resolveReactionTarget(-1, ids, 'last'), 'last');
  assert.equal(resolveReactionTarget(3, ids, 'last'), 'last');   // past end
  assert.equal(resolveReactionTarget(1.5, ids, 'last'), 'last'); // non-integer
});

test('resolveReactionTarget: empty id list always falls back', () => {
  assert.equal(resolveReactionTarget(1, [], 'last'), 'last');
});
