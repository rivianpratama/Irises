// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// One invariant, four clocks. Every timestamp the Convo model reads in a single turn has to render
// in the USER's zone, because it reads them together and reasons across them: the bracketed stamp on
// each transcript row, the "your last one at" stamp on the reply-order line, the tapped-reply date
// label that rides into durable history, and the weekday/daypart words the conversation-timing block
// hands her. Only "## Current time" honoured the stored `agent_tz`; the other four fell through to
// DEFAULT_TZ — the HOST's zone, UTC in production — so a user in Asia/Jakarta got one prompt carrying
// two clocks seven hours apart, and the model cited the wrong one: live, at 08:15 where they live,
// it read the transcript and said they had sent one word at 1am.
//
// The frozen instant below is that failure, kept: 2026-01-06T01:15Z is Tuesday 1:15 AM in UTC and
// Tuesday 8:15 AM in Jakarta — a different hour, a different daypart word, and for the older rows a
// different weekday and calendar date. So every test here renders BOTH zones and asserts they
// DIFFER, which is what stops a regression that re-hardcodes DEFAULT_TZ from passing by rendering
// the same string twice on a UTC host. The fallback is pinned too: no stored zone must build exactly
// what it built before.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPromptSections, formatHistory, renderReplyOrder, annotateTappedReply, type ChatContext,
} from './shared.js';
import { renderTimestamps } from '../../llm/timedMessages.js';
import type { StoredMessage } from '../../db/types.js';

// ── the frozen clock ─────────────────────────────────────────────────────────
// Same hand-rolled pin as promptSections.test.ts and promptBudget.test.ts (node:test's MockTimers
// prints an ExperimentalWarning): the assembler reads `new Date()` for its clock sections and
// annotateTappedReply reads `Date.now()` for the >24h test.
const FROZEN_MS = Date.UTC(2026, 0, 6, 1, 15, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const HOUR = 3_600_000;
const JAKARTA = 'Asia/Jakarta';
const HANDLE = '+15550001111';

// Six hours back: 2026-01-05T19:15Z. Monday evening in UTC, Tuesday small hours in Jakarta — the
// stamp on this row disagrees on the hour, the weekday AND the date, which is the whole point.
const LAST_BUBBLE_AT = FROZEN_MS - 6 * HOUR;

const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'did the cedars land', at: FROZEN_MS - 7 * HOUR },
  { role: 'assistant', content: 'checking now', at: LAST_BUBBLE_AT },
];

const CHAT: ChatContext = {
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE,
};

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** The assembler on a plain 1:1 turn, varying only the stored zone. `agentTz` is the 8th argument. */
function argsFor(agentTz: string | undefined): BuildArgs {
  return [
    CHAT, '', [], undefined, undefined, HISTORY, 'ok', agentTz,
    undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined,
  ];
}

/** The one line of the assembled prompt that starts with `prefix`. */
function lineStartingWith(system: string, prefix: string): string {
  return system.split('\n').find(l => l.startsWith(prefix)) ?? '';
}

// ── (1) the transcript stamps ────────────────────────────────────────────────

test('a transcript row renders its bracketed stamp on the user\'s clock, not the host\'s', () => {
  // formatHistory carries the label as the structured `timestamp`; the provider boundary
  // (llm/timedMessages.ts) is what folds it into the `[…]` the model actually reads, so assert on
  // the wire form — that is the string the "one word at 1am" reading came from.
  const jakarta = renderTimestamps(formatHistory(HISTORY, false, JAKARTA));
  const utc = renderTimestamps(formatHistory(HISTORY, false, 'UTC'));

  assert.equal(jakarta[1].content, '[Tue, Jan 6, 2:15 AM] checking now');
  assert.equal(utc[1].content, '[Mon, Jan 5, 7:15 PM] checking now');
  assert.notEqual(jakarta[0].content, utc[0].content);
});

test('a transcript row with no zone given falls back to DEFAULT_TZ, unchanged', () => {
  assert.deepEqual(formatHistory(HISTORY, false), formatHistory(HISTORY, false, 'UTC'));
});

// ── (2) the conversation-timing words ────────────────────────────────────────

test('the conversation_timing block reads the daypart off the user\'s clock', () => {
  const jakarta = buildSystemPromptSections(...argsFor(JAKARTA)).system;
  const utc = buildSystemPromptSections(...argsFor('UTC')).system;

  // 08:15 in Jakarta is morning; the same instant is 01:15 and "late night" on the host's clock, and
  // that sentence used to arrive in the same prompt as a Current-time line saying quarter past eight
  // in the morning.
  const jakartaClock = lineStartingWith(jakarta, "It's Tuesday");
  const utcClock = lineStartingWith(utc, "It's Tuesday");
  assert.equal(jakartaClock, "It's Tuesday morning for them.");
  assert.equal(utcClock, "It's Tuesday late night for them. Late night — keep it softer and lower-stakes.");
});

test('the timing regime itself is read in the user\'s zone, not the host\'s', () => {
  // The daypart word is not the only thing the block gets off the clock: whether the thread went
  // OVERNIGHT is a calendar-day comparison (chatTime.classifyGap → dayKey). Their last bubble is
  // 02:15 the same Tuesday morning in Jakarta and Monday evening in UTC, so the host's zone had the
  // model greeting someone who never went to bed.
  const jakarta = buildSystemPromptSections(...argsFor(JAKARTA)).system;
  const utc = buildSystemPromptSections(...argsFor('UTC')).system;

  assert.match(lineStartingWith(jakarta, 'The thread was last alive'), /earlier today\. Pick up naturally/);
  assert.match(lineStartingWith(utc, 'The last exchange was'), /before their night\. They're coming back fresh/);
});

test('the clock block and the timing block name the same daypart', () => {
  // The disagreement the bug actually was: two sections, one prompt, seven hours apart.
  const { system } = buildSystemPromptSections(...argsFor(JAKARTA));
  assert.match(lineStartingWith(system, "Right now it's"), /8:15 AM for them, in Asia\/Jakarta/);
  assert.ok(!system.includes("It's Tuesday late night for them."));
});

test('the assembler with no stored zone builds exactly what it built before', () => {
  assert.equal(
    buildSystemPromptSections(...argsFor(undefined)).system,
    buildSystemPromptSections(...argsFor('UTC')).system,
  );
});

// ── (3) the reply-order stamp ────────────────────────────────────────────────

test('renderReplyOrder\'s "your last one at" stamp is in the user\'s zone', () => {
  const jakarta = renderReplyOrder(HISTORY, 'ok', false, JAKARTA);
  const utc = renderReplyOrder(HISTORY, 'ok', false, 'UTC');

  assert.match(jakarta, /your last one at Tue, Jan 6, 2:15 AM/);
  assert.match(utc, /your last one at Mon, Jan 5, 7:15 PM/);
  assert.equal(renderReplyOrder(HISTORY, 'ok', false), utc); // no zone → DEFAULT_TZ, unchanged
});

// ── (4) the tapped-reply date label, which persists ──────────────────────────

test('annotateTappedReply dates the quote on the user\'s clock — and that label is durable', () => {
  // >24h back so the label renders at all: 2026-01-04T19:15Z, Sunday evening in UTC and Monday
  // small hours in Jakarta. This string is written into stored history before addMessage, so a
  // wrong zone here is a wrong hour the model re-reads on every future turn.
  const sentAtMs = FROZEN_MS - 30 * HOUR;
  const repliedTo = { kind: 'assistant' as const, text: 'water heater is aging', sentAtMs };

  assert.match(annotateTappedReply('how old', repliedTo, JAKARTA), /from Mon, Jan 5, 2:15 AM:/);
  assert.match(annotateTappedReply('how old', repliedTo, 'UTC'), /from Sun, Jan 4, 7:15 PM:/);
  assert.equal(annotateTappedReply('how old', repliedTo), annotateTappedReply('how old', repliedTo, 'UTC'));
});
