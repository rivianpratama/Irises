// The early sink through the front door (convo/client.ts `chat`): the model faked at the lane seam
// as a STREAMING call — it feeds the envelope to `onTextDelta` in pieces before it returns, the way
// the OpenAI-compatible lanes do — and nothing else stubbed. What is pinned is the one promise the
// feature makes and the one it must never break:
//   • on an armed turn the first sentence reaches the send sink while the call is still running,
//     and the reply's final send is only what came after it;
//   • a turn whose envelope carries a tool call never sends anything early, whatever its bubbles say;
//   • a stream that breaks is recovered by what went out: re-run unstreamed when nothing did, and cut
//     to exactly what did otherwise, and the envelope retry asks the same question before resending.
// Runs against the ephemeral DB backend, like routingGate.test.ts's front-door test.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from './client.js';
import { callConvoLLM, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { remainderAfterPrefix, cleanBubbles } from '../../pipeline/earlyEmit.js';
import { splitIntoBubbles } from '../../pipeline/bubbles.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

const ASK = 'whats 17% of 2400';

/** A lane that streams `envelope` to the sink in small pieces, yielding between them so the sink's
 *  sends get to run mid-call, and logs when it returns. */
function streamingCall(envelope: object, log: string[]): (req: LlmRequest) => Promise<LlmResult> {
  return async req => {
    const text = JSON.stringify(envelope);
    if (req.onTextDelta) {
      for (let i = 0; i < text.length; i += 7) {
        req.onTextDelta(text.slice(i, i + 7));
        await new Promise(r => setImmediate(r));
      }
    }
    log.push('call:end');
    return { text, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test', emitted: !!req.onTextDelta };
  };
}

let seq = 0;
function ctx(log: string[], sent: string[]): ChatContext {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555802${(seq++).toString().padStart(4, '0')}`;
  return {
    isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender,
    earlySend: async (sentence, isFirst) => {
      log.push(`send:${isFirst ? 'first' : 'next'}:${sentence}`);
      sent.push(sentence);
      return { shown: sentence };
    },
  };
}

test('an armed turn sends its first sentence mid-call, and the final send is only the rest', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  // The second bubble is one the per-sentence scan blocks (a capability refusal), so it stops the
  // stream there: what went early is the first sentence alone, and the rest is the pipeline's. No
  // engine is configured, so the refusal floor has nothing to force and the draft ships as written.
  const envelope = {
    confidence_level: 95,
    tool_calls: null,
    bubbles: [{ text: 'thats 408.', re: null }, { text: "i can't browse the web from here though", re: null }],
    status: {},
  };
  const out = await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent), streamingCall(envelope, log));
  log.push('chat:resolved');

  assert.deepEqual(sent, ['thats 408.'], `only the first sentence went early: ${log.join(' | ')}`);
  assert.ok(log.indexOf('send:first:thats 408.') < log.indexOf('call:end'), `it went out before the call returned: ${log.join(' | ')}`);
  assert.deepEqual(out.emittedPrefix, sent, 'the reply says exactly what went early');
  const ev = getTraces().find(e => e.label === 'convo:early_send');
  assert.equal((ev?.detail as { disarmed?: string } | undefined)?.disarmed, 'refusal');

  // What the send boundary then sends (index.ts): the final bubbles minus what is on their screen.
  const { rest, diverged } = remainderAfterPrefix(splitIntoBubbles(out.text ?? ''), sent);
  assert.equal(diverged, false);
  assert.deepEqual(rest, ["i can't browse the web from here though"]);
});

test('a delegating envelope never sends anything early', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  const envelope = {
    confidence_level: 80,
    tool_calls: [{ name: 'delegate_to_ops', args: { kind: 'web_research', meta_prompt: 'look it up' } }],
    bubbles: [{ text: 'on it.', re: null }, { text: 'give me a sec', re: null }],
    status: {},
  };
  await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent), streamingCall(envelope, log));
  assert.deepEqual(sent, [], `nothing went early: ${log.join(' | ')}`);
  const ev = getTraces().find(e => e.label === 'convo:early_send');
  assert.equal((ev?.detail as { disarmed?: string } | undefined)?.disarmed, 'tool_calls');
});

test('an echoed timestamp marker on the first bubble never sends that sentence twice', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  const envelope = {
    confidence_level: 95,
    tool_calls: null,
    bubbles: [{ text: '[9:14 AM] thats 408.', re: null }, { text: "i can't browse the web from here though", re: null }],
    status: {},
  };
  const out = await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent), streamingCall(envelope, log));
  assert.deepEqual(sent, ['thats 408.'], 'the marker was stripped on the way out');
  // The send boundary's cut (index.ts): its per-bubble guardrail is the same four steps as cleanBubbles.
  const { rest, diverged } = remainderAfterPrefix(cleanBubbles(out.text ?? ''), sent);
  assert.equal(diverged, false);
  assert.deepEqual(rest, ["i can't browse the web from here though"]);
});

/** A lane whose stream breaks: it feeds `partial` and returns it as a cut partial. */
function brokenThenWhole(partial: string, whole: object, calls: LlmRequest[]): (req: LlmRequest) => Promise<LlmResult> {
  return async req => {
    calls.push(req);
    if (req.onTextDelta) {
      for (let i = 0; i < partial.length; i += 7) {
        req.onTextDelta(partial.slice(i, i + 7));
        await new Promise(r => setImmediate(r));
      }
      return { text: partial, toolCalls: [], stopReason: 'error', provider: 'openrouter', model: 'test', emitted: true };
    }
    return { text: JSON.stringify(whole), toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' };
  };
}

test('a stream that breaks before anything went out is re-run once, unstreamed', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  const calls: LlmRequest[] = [];
  const whole = { confidence_level: 95, tool_calls: null, bubbles: [{ text: 'thats 408.', re: null }], status: {} };
  const out = await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent),
    brokenThenWhole('{"confidence_level":95,"tool_calls":null,"bubbles":[{"text":"thats 4', whole, calls));
  assert.deepEqual(sent, [], 'no sentence ever closed, so nothing went early');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].onTextDelta, undefined, 'the re-run does not stream');
  assert.equal(calls[1].trace?.label, 'convo:stream_rerun');
  assert.equal(out.text, 'thats 408.', 'the whole reply, never the repaired fragment');
  assert.equal(out.emittedPrefix, undefined);
});

test('the re-run of a broken stream counts against the turn\'s call cap', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  const calls: LlmRequest[] = [];
  // The re-run comes back empty, so the silent-turn retry spends the turn's third call. That retry
  // promises work with no tool behind it, which the guard would re-ask: a fourth call, had the re-run
  // gone uncounted.
  const unkept = { confidence_level: 95, tool_calls: null, bubbles: [{ text: 'on it', re: null }], status: {} };
  const empty = { confidence_level: 95, tool_calls: null, bubbles: [], status: {} };
  const lane = async (req: LlmRequest): Promise<LlmResult> => {
    calls.push(req);
    if (req.onTextDelta) {
      const partial = '{"confidence_level":95,"tool_calls":null,"bubbles":[{"text":"thats 4';
      req.onTextDelta(partial);
      return { text: partial, toolCalls: [], stopReason: 'error', provider: 'openrouter', model: 'test', emitted: true };
    }
    return { text: JSON.stringify(calls.length === 2 ? empty : unkept), toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' };
  };
  await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent), lane);
  assert.ok(calls.length <= 3, `at most three convo calls, the broken stream included: ${calls.map(c => c.trace?.label).join(', ')}`);
});

test('a stream that breaks after a sentence went out keeps that sentence and nothing of the fragment', async () => {
  const log: string[] = [];
  const sent: string[] = [];
  const calls: LlmRequest[] = [];
  const out = await chat(randomUUID(), ASK, emptyMedia(), ctx(log, sent),
    brokenThenWhole('{"confidence_level":95,"tool_calls":null,"bubbles":[{"text":"thats 408. and also th', {}, calls));
  assert.deepEqual(sent, ['thats 408.']);
  assert.equal(calls.length, 1, 'nothing re-runs over what they already have');
  assert.ok(!(out.text ?? '').includes('also'), `no fragment ships: ${out.text}`);
  assert.deepEqual(remainderAfterPrefix(cleanBubbles(out.text ?? ''), sent).rest, [], 'nothing left to send');
});

test('the envelope retry still runs on a streamed reply nobody has seen, and never on one they have', async () => {
  const prose = 'thats 408 lol';
  const fixed = JSON.stringify({ confidence_level: 90, tool_calls: null, bubbles: [{ text: 'thats 408', re: null }] });
  const lane = (reqs: LlmRequest[]) => async (req: LlmRequest): Promise<LlmResult> => {
    reqs.push(req);
    return reqs.length === 1
      ? { text: prose, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test', emitted: true }
      : { text: fixed, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' };
  };
  const base: LlmRequest = { role: 'convo', messages: [{ role: 'user', content: ASK }], onTextDelta: () => {}, trace: { label: 'convo' } };

  const unseen: LlmRequest[] = [];
  let frozen = false;
  const retried = await callConvoLLM(base, { committed: () => false, freeze: () => { frozen = true; }, llm: lane(unseen) });
  assert.equal(unseen.length, 2, 'nothing was committed, so the corrective retry ran');
  assert.ok(frozen, 'the sink was frozen first');
  assert.equal(unseen[1].onTextDelta, undefined, 'and the retry did not stream');
  assert.equal(unseen[1].trace?.label, 'convo:json_retry');
  assert.equal(retried.text, fixed);

  const seen: LlmRequest[] = [];
  const kept = await callConvoLLM(base, { committed: () => true, llm: lane(seen) });
  assert.equal(seen.length, 1, 'something is on their screen, so nothing is resent');
  assert.equal(kept.text, prose);
});
