// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The pure half of the reply-language standing setting: what counts as an explicit ask, what an old
// model-written language RULE says, which of the turn's three inputs wins, and how the slot renders.
// No DB, no env, no clock — every instant is passed in, so these cases read as the specification
// they are.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLY_LANGUAGE_KEY, detectEnglishAsk, parseLanguageDirective, applyLanguageRequest,
  renderReplyLanguageLine,
} from './standingSettings.js';
import { shortDateLabel } from '../pipeline/chatTime.js';

test('the slot key is the one both stores and the tool agree on', () => {
  assert.equal(REPLY_LANGUAGE_KEY, 'reply_language');
});

// ── the English fast path ────────────────────────────────────────────────────
// The LANGUAGE-AGNOSTIC RULE (agents/ops/sideEffects.ts) says English is the only lexicon in `src/`:
// this is the free, deterministic catch for "talk english" — every other language rides the model's
// `language_request` tag or its tool call.

test('detectEnglishAsk catches an explicit ask to switch to English', () => {
  for (const text of [
    'btw change the language to english',
    'we talk in english now',
    'talk to me in english',
    'can we go back to english',
    'reply in english pls',
    'switch to english',
  ]) {
    assert.equal(detectEnglishAsk(text), true, text);
  }
});

test('detectEnglishAsk refuses a translation question, a negation, a third party and a long message', () => {
  for (const text of [
    // A question ABOUT English is not an instruction to reply in it.
    'how do you say cat in english',
    'what does jir mean in english',
    'whats the meaning of jir in english',
    // Told NOT to.
    "don't switch to english",
    'do not talk to me in english',
    // Somebody else's language, not hers.
    'did you talk to him in english?',
    'did you speak to them in english',
    // No cue at all.
    "i'm indonesian",
    'english muffins are underrated',
    // Quoted text is data the user is talking ABOUT, exactly as the side-effect lexicon reads it.
    'he said "switch to english" and left',
    // Past the word ceiling: an ask is short, a story is not.
    'i was reading a really long article about how the whole team decided to write all of their docs in english',
  ]) {
    assert.equal(detectEnglishAsk(text), false, text);
  }
});

test('detectEnglishAsk is safe on nothing at all', () => {
  assert.equal(detectEnglishAsk(''), false);
  assert.equal(detectEnglishAsk('   '), false);
});

// ── the legacy directive parser ──────────────────────────────────────────────
// Language rules were saved as medium-tier DIRECTIVES until this plan; the parser is what lets code
// recognize one so it can be folded into the slot and retired instead of standing forever.

test('parseLanguageDirective reads the language out of a model-written rule', () => {
  assert.equal(parseLanguageDirective('always reply in Indonesian'), 'Indonesian');
  assert.equal(parseLanguageDirective('reply in Spanish'), 'Spanish');
  assert.equal(parseLanguageDirective('Always reply in Bahasa Indonesia.'), 'Bahasa Indonesia');
  assert.equal(parseLanguageDirective('please always respond in french'), 'French');
  assert.equal(parseLanguageDirective('always reply to me only in Tagalog'), 'Tagalog');
});

test('parseLanguageDirective never mistakes a STYLE rule for a language', () => {
  for (const text of [
    'always reply in short sentences',
    'always reply in lowercase',
    'reply in bullet points',
    'keep replies short',
    'full sarcasm mode always',
    'lebih proaktif dengan semuanya',
    '',
  ]) {
    assert.equal(parseLanguageDirective(text), null, text);
  }
});

// ── per-turn precedence ──────────────────────────────────────────────────────

test('applyLanguageRequest: a tool write ends the turn, then the fast path, then the tag', () => {
  // The tool already wrote the slot itself — a second write would be the same value twice and a
  // second supersede pass over the same directives.
  assert.equal(applyLanguageRequest({ fastPathAsk: true, toolWrote: true, tag: 'Spanish' }), null);
  assert.equal(applyLanguageRequest({ fastPathAsk: false, toolWrote: true, tag: undefined }), null);

  assert.deepEqual(
    applyLanguageRequest({ fastPathAsk: true, toolWrote: false, tag: undefined }),
    { value: 'English', via: 'fast_path' },
  );
  // The fast path is code reading the user's own words; the tag is the model's report of them.
  assert.deepEqual(
    applyLanguageRequest({ fastPathAsk: true, toolWrote: false, tag: 'Spanish' }),
    { value: 'English', via: 'fast_path' },
  );
  assert.deepEqual(
    applyLanguageRequest({ fastPathAsk: false, toolWrote: false, tag: 'Spanish' }),
    { value: 'Spanish', via: 'tag' },
  );
  // Nothing happened this turn: the slot keeps whatever it held.
  assert.equal(applyLanguageRequest({ fastPathAsk: false, toolWrote: false, tag: undefined }), null);
  assert.equal(applyLanguageRequest({ fastPathAsk: false, toolWrote: false, tag: '  ' }), null);
});

// ── the rendered line ────────────────────────────────────────────────────────

test('renderReplyLanguageLine dates the setting in the reader-facing zone', () => {
  assert.equal(
    renderReplyLanguageLine('English', Date.UTC(2026, 8, 4, 14, 52), Date.UTC(2026, 8, 5), 'Asia/Jakarta'),
    'Reply language: English (they asked on Sep 4)',
  );
  // An older year is spelled out, so "Aug 30" can never read as this August.
  assert.equal(
    renderReplyLanguageLine('Indonesian', Date.UTC(2025, 7, 30), Date.UTC(2026, 8, 5), 'UTC'),
    'Reply language: Indonesian (they asked on Aug 30, 2025)',
  );
  // No date on the row (a legacy write) — the setting still renders; only the receipt is missing.
  assert.equal(renderReplyLanguageLine('English', undefined, Date.UTC(2026, 8, 5), 'UTC'), 'Reply language: English');
  assert.equal(renderReplyLanguageLine('English', NaN, Date.UTC(2026, 8, 5), 'UTC'), 'Reply language: English');
});

test('renderReplyLanguageLine renders nothing at all when the slot is empty', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(renderReplyLanguageLine(v, Date.UTC(2026, 8, 4), Date.UTC(2026, 8, 5), 'UTC'), null, String(v));
  }
});

test('shortDateLabel keeps the year off a same-year date and degrades to empty on junk', () => {
  assert.equal(shortDateLabel(Date.UTC(2026, 8, 4, 23, 30), 'Asia/Jakarta', Date.UTC(2026, 8, 5)), 'Sep 5');
  assert.equal(shortDateLabel(Date.UTC(2026, 8, 4, 23, 30), 'UTC', Date.UTC(2026, 8, 5)), 'Sep 4');
  assert.equal(shortDateLabel(Date.UTC(2025, 11, 31), 'UTC', Date.UTC(2026, 8, 5)), 'Dec 31, 2025');
  assert.equal(shortDateLabel(Number.NaN, 'UTC', Date.UTC(2026, 8, 5)), '');
  assert.equal(shortDateLabel(Date.UTC(2026, 8, 4), 'Not/AZone', Date.UTC(2026, 8, 5)), '');
});
