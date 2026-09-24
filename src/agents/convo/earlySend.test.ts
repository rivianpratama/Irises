// The early sink through the front door (convo/client.ts `chat`): the model faked at the lane seam
// as a STREAMING call — it feeds the envelope to `onTextDelta` in pieces before it returns, the way
// the OpenAI-compatible lanes do — and nothing else stubbed. What is pinned is the one promise the
// feature makes and the one it must never break:
//   • on an armed turn the first sentence reaches the send sink while the call is still running,
//     and the reply's final send is only what came after it;
//   • a turn whose envelope carries a tool call never sends anything early, whatever its bubbles say.
// Runs against the ephemeral DB backend, like routingGate.test.ts's front-door test.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from './client.js';
import type { ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { remainderAfterPrefix } from '../../pipeline/earlyEmit.js';
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
