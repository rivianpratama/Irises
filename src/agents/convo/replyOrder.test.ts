// Run with: npm test   (TZ=UTC tsx --test)
// renderReplyOrder — the computed "what their new message is landing on" line — and
// handleCancelResearch — the cancel_research tool's branch table (in-memory opsCoordination).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReplyOrder, renderArrivalGap, buildSystemPrompt, hasTappedReply, handleCancelResearch, type ChatContext } from './shared.js';
import { dateTimeInZone } from '../../pipeline/zonedTime.js';
import { markOpsStart, markOpsDone, isOpsCancelled, getActiveOps, __resetOpsCoordination } from '../../state/opsCoordination.js';
import type { StoredMessage } from '../../state/conversation.js';

const NOW = dateTimeInZone('2026-07-06', { hour: 21, minute: 14 });
const MIN = 60_000;

const irisesRun: StoredMessage[] = [
  { role: 'user', content: 'is there any new email?', at: NOW - 10 * MIN },
  { role: 'assistant', content: 'one new email since 245', at: NOW - 3 * MIN },
  { role: 'assistant', content: 'nothing else came through in that window', at: NOW - 3 * MIN },
  { role: 'assistant', content: 'got the full inbox scan if you wanna double check', at: NOW - 2 * MIN },
];

// ── renderReplyOrder ─────────────────────────────────────────────────────────

test('a run of Irises bubbles + a short inbound → ordering line WITH the closure hint', () => {
  const out = renderReplyOrder(irisesRun, 'ok', false);
  assert.match(out, /run of 3 bubbles/);
  assert.match(out, /9:12 PM/); // last assistant bubble's stamp
  assert.match(out, /not necessarily your very last bubble/);
  assert.match(out, /CLOSES THE LOOP/);
});

test('a longer inbound gets the ordering line but NOT the closure hint', () => {
  const out = renderReplyOrder(irisesRun, 'can you check the other months too please', false);
  assert.match(out, /run of 3 bubbles/);
  assert.ok(!out.includes('CLOSES THE LOOP'));
});

test('no line when their last turn was theirs (nothing of Irises\'s to land on)', () => {
  const history: StoredMessage[] = [
    { role: 'assistant', content: 'anytime', at: NOW - 5 * MIN },
    { role: 'user', content: 'one more thing', at: NOW - MIN },
  ];
  assert.equal(renderReplyOrder(history, 'ok', false), '');
});

test('a tapped reply silences the line (the explicit target wins) and so does empty history', () => {
  assert.equal(renderReplyOrder(irisesRun, 'ok', true), '');
  assert.equal(renderReplyOrder([], 'ok', false), '');
});

test('a single trailing bubble reads as "one bubble" and survives a missing timestamp', () => {
  const history: StoredMessage[] = [
    { role: 'user', content: 'thanks', at: NOW - 4 * MIN },
    { role: 'assistant', content: 'anytime' }, // no `at`
  ];
  const out = renderReplyOrder(history, 'ok', false);
  assert.match(out, /run of one bubble/);
  assert.ok(!out.includes('NaN'));
});

// ── renderArrivalGap (message OLDER than Irises's latest sends) ─────────────────

const gap = (sends: number, receivedAt = NOW - 5 * MIN) => [{ receivedAt, sendsAfterArrival: sends }];

test('nothing stale (all sendsAfterArrival 0), empty, or undefined → no section', () => {
  assert.equal(renderArrivalGap(gap(0), false), '');
  assert.equal(renderArrivalGap([], false), '');
  assert.equal(renderArrivalGap(undefined, false), '');
});

test('a tapped reply silences the gap section (explicit target wins)', () => {
  assert.equal(renderArrivalGap(gap(2), true), '');
});

test('single stale message → BEFORE claim, send count, react license, closure + answer lines', () => {
  const out = renderArrivalGap(gap(2), false);
  assert.match(out, /Timing note — their message is OLDER/);
  assert.match(out, /typed BEFORE the last 2 messages you sent/);
  assert.match(out, /already answers or moots it, do NOT answer it again/);
  assert.match(out, /send_reaction/);
  assert.match(out, /still stands unanswered, answer normally/);
});

test('singular count reads "1 message" (not "1 messages")', () => {
  const out = renderArrivalGap(gap(1), false);
  assert.match(out, /the last 1 message you sent/);
});

test('burst: names only the stale [msg N]s, and offers re-targeted reactions', () => {
  // msg 1 & 2 predate later sends; msg 3 came after them (not stale).
  const arrivals = [
    { receivedAt: NOW - 6 * MIN, sendsAfterArrival: 2 },
    { receivedAt: NOW - 6 * MIN, sendsAfterArrival: 1 },
    { receivedAt: NOW - 1 * MIN, sendsAfterArrival: 0 },
  ];
  const out = renderArrivalGap(arrivals, false);
  assert.match(out, /\[msg 1\] and \[msg 2\] were typed BEFORE the last 2 messages/);
  assert.ok(!out.includes('[msg 3]'), 'the non-stale message is not named');
  assert.match(out, /set `re` to its number on send_reaction/);
});

// ── buildSystemPrompt: which order-read section shows ─────────────────────────

const ctxWith = (over: Partial<ChatContext>): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, ...over,
});

test('gapped turn: the Timing-note section REPLACES the reply-order line', () => {
  const prompt = buildSystemPrompt(
    ctxWith({ arrivals: gap(2) }), '', [], undefined, undefined, irisesRun, 'ok', undefined,
  );
  assert.match(prompt, /## Timing note — their message is OLDER/);
  assert.ok(!prompt.includes('## What their new message is landing on'), 'the (now-inverted) reply-order line is suppressed when gapped');
});

test('non-gapped turn: the ordinary reply-order line shows, no Timing note', () => {
  const prompt = buildSystemPrompt(
    ctxWith({ arrivals: gap(0) }), '', [], undefined, undefined, irisesRun, 'ok', undefined,
  );
  assert.match(prompt, /## What their new message is landing on/);
  assert.ok(!prompt.includes('## Timing note'), 'no Timing note when nothing is stale');
});

// ── buildSystemPrompt: which tapped-reply section shows, and order-read suppression ──

test('repliedTo "assistant": the bubble section shows; legacy repliedToText still works too', () => {
  const viaResolved = buildSystemPrompt(
    ctxWith({ repliedTo: { kind: 'assistant', text: 'the deposit clears on the 14th' } }),
    '', [], undefined, undefined, irisesRun, 'breakdown?', undefined,
  );
  assert.match(viaResolved, /## They tapped reply on a SPECIFIC earlier bubble of yours/);
  const viaLegacy = buildSystemPrompt(
    ctxWith({ repliedToText: 'the deposit clears on the 14th' }),
    '', [], undefined, undefined, irisesRun, 'breakdown?', undefined,
  );
  assert.match(viaLegacy, /## They tapped reply on a SPECIFIC earlier bubble of yours/);
});

test('repliedTo "own-thread": thread section shows; BOTH order-read sections suppressed even when stale', () => {
  const prompt = buildSystemPrompt(
    ctxWith({
      repliedTo: { kind: 'own-thread', rootText: 'when does the deposit clear?', assistantBubbles: ['the deposit clears on the 14th'] },
      arrivals: gap(2), // stale — would normally trigger the Timing note
    }),
    '', [], undefined, undefined, irisesRun, 'can u do a breakdown', undefined,
  );
  assert.match(prompt, /## They tapped reply INSIDE one of your answer threads/);
  assert.match(prompt, /the deposit clears on the 14th/); // the answer bubble is quoted
  assert.ok(!prompt.includes('## What their new message is landing on'), 'reply-order suppressed on a tapped reply');
  assert.ok(!prompt.includes('## Timing note'), 'Timing note suppressed on a tapped reply, even when stale');
});

test('repliedTo "unresolved": acknowledge-and-ask section shows, both order-read sections suppressed', () => {
  const prompt = buildSystemPrompt(
    ctxWith({ repliedTo: { kind: 'unresolved' }, arrivals: gap(0) }),
    '', [], undefined, undefined, irisesRun, 'wdym', undefined,
  );
  assert.match(prompt, /## They tapped reply on a SPECIFIC earlier message you can't pull up/);
  assert.match(prompt, /can't pull it up/); // acknowledge-and-ask voice, not a silent guess
  assert.ok(!prompt.includes('## What their new message is landing on'), 'reply-order suppressed when a target was tapped but unresolved');
  assert.ok(!prompt.includes('## Timing note'));
});

test('repliedTo assistant BEYOND recall: adds the "older than the conversation" acknowledge-and-ask note', () => {
  const prompt = buildSystemPrompt(
    ctxWith({ repliedTo: { kind: 'assistant', text: 'the deposit clears on the 14th', sentAtMs: NOW - 60 * MIN, viaLiveFetch: true } }),
    '', [], undefined, undefined, irisesRun, 'breakdown?', undefined,
  );
  assert.match(prompt, /## They tapped reply on a SPECIFIC earlier bubble of yours/);
  assert.match(prompt, /OLDER than the conversation you can see above/);
  assert.match(prompt, /ask ONE short question/);
});

test('repliedTo assistant WITHIN recall: no beyond-recall note (the exchange is still visible)', () => {
  const prompt = buildSystemPrompt(
    ctxWith({ repliedTo: { kind: 'assistant', text: 'the deposit clears on the 14th', sentAtMs: NOW - 1 * MIN, viaLiveFetch: true } }),
    '', [], undefined, undefined, irisesRun, 'breakdown?', undefined,
  );
  assert.ok(!prompt.includes('OLDER than the conversation you can see above'), 'no beyond-recall note for a recent message');
});

test('hasTappedReply truth table (incl. legacy repliedToText and no-context)', () => {
  assert.equal(hasTappedReply(undefined), false);
  assert.equal(hasTappedReply(ctxWith({})), false);
  assert.equal(hasTappedReply(ctxWith({ repliedToText: 'x' })), true);
  assert.equal(hasTappedReply(ctxWith({ repliedTo: { kind: 'unresolved' } })), true);
  assert.equal(hasTappedReply(ctxWith({ repliedTo: { kind: 'assistant', text: 'x' } })), true);
});

// ── handleCancelResearch ─────────────────────────────────────────────────────

test('nothing running → honest nothing_found, never a fake cancel', () => {
  __resetOpsCoordination();
  const note = handleCancelResearch('', 'chatA');
  assert.equal(note?.kind, 'nothing_found');
});

test('exactly one running + empty match → clean cancel (null), task flagged and hidden', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' }, new AbortController());
  const note = handleCancelResearch('', 'chatA');
  assert.equal(note, null);
  assert.equal(isOpsCancelled('chatA', 't1'), true);
  assert.equal(getActiveOps('chatA').length, 0);
});

test('several running + empty match → failed outcome that lists them so Irises asks which', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  markOpsStart('chatA', 't2', { kind: 'web_research', request: 'comps on 412 maple' });
  const note = handleCancelResearch('', 'chatA');
  assert.equal(note?.kind, 'failed');
  assert.match(note?.facts ?? '', /full inbox scan/);
  assert.match(note?.facts ?? '', /comps on 412 maple/);
  // Nothing was cancelled while it's ambiguous.
  assert.equal(getActiveOps('chatA').length, 2);
});

test('several running + a match → cancels only the matching one', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' }, new AbortController());
  markOpsStart('chatA', 't2', { kind: 'web_research', request: 'comps on 412 maple' }, new AbortController());
  const note = handleCancelResearch('inbox', 'chatA');
  assert.equal(note, null);
  assert.equal(isOpsCancelled('chatA', 't1'), true);
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'comps on 412 maple');
});

test('a match that fits nothing → nothing_found listing what IS running', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' });
  const note = handleCancelResearch('mortgage rates', 'chatA');
  assert.equal(note?.kind, 'nothing_found');
  assert.match(note?.facts ?? '', /full inbox scan/);
});

test('cancel is chat-scoped: another chat\'s lookup is untouchable and invisible', () => {
  __resetOpsCoordination();
  markOpsStart('chatB', 't1', { kind: 'general', request: 'full inbox scan' });
  const note = handleCancelResearch('', 'chatA');
  assert.equal(note?.kind, 'nothing_found');
  assert.equal(getActiveOps('chatB').length, 1);
});

test('double-cancel: second call finds nothing running (idempotent, honest)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 't1', { kind: 'general', request: 'full inbox scan' }, new AbortController());
  assert.equal(handleCancelResearch('', 'chatA'), null);
  const second = handleCancelResearch('', 'chatA');
  assert.equal(second?.kind, 'nothing_found');
  markOpsDone('chatA', 't1'); // cleanup
});