// The reply-language slot, end to end through processConvoResult — the three inputs that can set it
// and the one that clears it.
//
// This is the file that would have caught the 2026-09-04 failure: the user asked for English twice,
// was told "switching now" both times, and `always reply in Indonesian` stayed active because the
// only mechanism was an optional tool call the model never made. Now the turn writes the slot from
// whichever input it has — the model's own `set_preference`, the English fast path over the user's
// text, or the hidden `language_request` tag — and retires the old language rule with it.
//
// Runs against the in-memory backend; no LLM leg is involved (the status envelope is handed in as a
// fixture, exactly as the model would have emitted it).
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getConversation } from '../../db/repositories/conversations.js';
import { getMemory } from '../../db/repositories/memory.js';
import { addDirective, listMediumActive, listMediumAll } from '../../db/repositories/memoryMedium.js';
import { setReplyLanguage } from '../../memory/replyLanguage.js';
import { REPLY_LANGUAGE_KEY } from '../../memory/standingSettings.js';
import { groupHandle } from '../../memory/identity.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

/** The model's reply, envelope and all. `status` is what `coerceStatus` reads on the far side, so
 *  the `language_request` tag has to ride INSIDE the JSON text — not beside it. */
function makeResult(
  bubbles: string[],
  toolCalls: LlmToolCall[],
  status: Record<string, unknown> = {},
): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
    status: { mood_label: 'content', mood_shift: 'steady', ...status },
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}

const setPref = (key: string, value: unknown): LlmToolCall => ({ name: 'set_preference', input: { key, value } });
const directives = (op: string, opts: { text?: string; match?: string } = {}): LlmToolCall =>
  ({ name: 'update_directives', input: { op, text: opts.text ?? null, match: opts.match ?? null } });

let seq = 0;
function baseArgs(group = false) {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555700${(seq++).toString().padStart(4, '0')}`;
  const chatId = randomUUID();
  const chatContext: ChatContext = { isGroupChat: group, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId, handle: group ? groupHandle(chatId) : sender, chatContext, history: [], media: emptyMedia() };
}

/** The slot, read from BOTH stores — a value in one only is the bug this feature exists to kill. */
async function slot(handle: string): Promise<{ fact: string | undefined; pref: unknown }> {
  const rows = await listMediumActive(handle, ['fact']);
  return {
    fact: rows.find(r => r.key === REPLY_LANGUAGE_KEY)?.body,
    pref: (await getMemory(handle))?.prefs[REPLY_LANGUAGE_KEY],
  };
}

function languageReceipts() {
  return getTraces().filter(e => e.label === 'memory:reply_language');
}

// ── the model's own tool call ────────────────────────────────────────────────

test("set_preference key='reply_language' sets the slot and retires the old language rule", async () => {
  const a = baseArgs();
  await addDirective(a.handle, 'always reply in Indonesian');
  await addDirective(a.handle, 'full sarcasm mode always');
  clearTraces();

  const res = makeResult(['sure, english from now on'], [setPref('reply_language', 'english')]);
  await processConvoResult({ ...a, res, textToSend: 'change the language to english' });

  assert.deepEqual(await slot(a.handle), { fact: 'English', pref: 'English' });
  const active = await listMediumActive(a.handle, ['directive']);
  assert.deepEqual(active.map(d => d.body), ['full sarcasm mode always'], 'only the language rule is retired');
  const retired = (await listMediumAll(a.handle)).find(e => e.body === 'always reply in Indonesian');
  assert.equal(retired?.status, 'superseded');

  // The hook must NOT write again on top of the tool: one ask, one write, one receipt.
  assert.equal(languageReceipts().length, 1);
  assert.equal(languageReceipts()[0].detail?.via, 'tool');
});

test('a garbled reply_language value is dropped, never written as a setting', async () => {
  const a = baseArgs();
  const res = makeResult(['ok'], [setPref('reply_language', 'whatever you think is best, honestly')]);
  await processConvoResult({ ...a, res, textToSend: 'you pick' });

  assert.deepEqual(await slot(a.handle), { fact: undefined, pref: undefined });
});

test('a language saved through update_directives becomes the SLOT, not a rule', async () => {
  const a = baseArgs();
  const res = makeResult(['vale, español'], [directives('add', { text: 'always reply in Spanish' })]);
  await processConvoResult({ ...a, res, textToSend: 'hablemos en español' });

  assert.deepEqual(await slot(a.handle), { fact: 'Spanish', pref: 'Spanish' });
  assert.deepEqual(await listMediumActive(a.handle, ['directive']), [], 'no rule row is created');
  assert.equal(languageReceipts().length, 1);
});

test('a NON-language directive still saves as a rule and never touches the slot', async () => {
  const a = baseArgs();
  const res = makeResult(['got it'], [directives('add', { text: 'keep replies short' })]);
  await processConvoResult({ ...a, res, textToSend: 'keep it short please' });

  assert.deepEqual((await listMediumActive(a.handle, ['directive'])).map(d => d.body), ['keep replies short']);
  assert.deepEqual(await slot(a.handle), { fact: undefined, pref: undefined });
});

test('removing a language rule CLEARS the slot — the setting cannot outlive its rule', async () => {
  const a = baseArgs();
  await addDirective(a.handle, 'always reply in Indonesian');
  await setReplyLanguage(a.handle, 'Indonesian', { source: 'convo', via: 'fold' });
  // The fold-shaped seed retires the rule it came from; put it back so `remove` has a target.
  await addDirective(a.handle, 'always reply in Indonesian');
  assert.equal((await slot(a.handle)).fact, 'Indonesian');
  clearTraces();

  const res = makeResult(['back to english then'], [directives('remove', { match: 'indonesian' })]);
  await processConvoResult({ ...a, res, textToSend: 'drop the indonesian rule' });

  assert.deepEqual(await listMediumActive(a.handle, ['directive']), []);
  assert.deepEqual(await slot(a.handle), { fact: undefined, pref: undefined });
});

// ── the fast path and the tag ────────────────────────────────────────────────

test('an English ask with NO tool call is captured by code anyway (the 2026-09-04 bug)', async () => {
  const a = baseArgs();
  await addDirective(a.handle, 'always reply in Indonesian');
  clearTraces();

  const res = makeResult(['switching now'], [], { language_request: null });
  await processConvoResult({ ...a, res, textToSend: 'we talk in english now' });

  assert.deepEqual(await slot(a.handle), { fact: 'English', pref: 'English' });
  assert.deepEqual(await listMediumActive(a.handle, ['directive']), [], 'the stale rule goes with it');
  assert.equal(languageReceipts()[0].detail?.via, 'fast_path');
});

test('a language the fast path cannot read arrives through the status tag', async () => {
  const a = baseArgs();
  const res = makeResult(['claro que sí'], [], { language_request: 'Spanish' });
  await processConvoResult({ ...a, res, textToSend: 'hablemos en español' });

  assert.deepEqual(await slot(a.handle), { fact: 'Spanish', pref: 'Spanish' });
  assert.equal(languageReceipts()[0].detail?.via, 'tag');
});

test('when the fast path and the tag disagree, the user\'s own words win', async () => {
  const a = baseArgs();
  const res = makeResult(['ok'], [], { language_request: 'Spanish' });
  await processConvoResult({ ...a, res, textToSend: 'we talk in english now' });

  assert.equal((await slot(a.handle)).fact, 'English');
  assert.equal(languageReceipts()[0].detail?.via, 'fast_path');
});

test('a question ABOUT english is not an ask, and nothing is written', async () => {
  const a = baseArgs();
  const res = makeResult(['"jir" is like "damn"'], [], { language_request: null });
  await processConvoResult({ ...a, res, textToSend: 'what does jir mean in english' });

  assert.deepEqual(await slot(a.handle), { fact: undefined, pref: undefined });
  assert.equal(languageReceipts().length, 0);
});

test('a group identity writes no standing language from text or tag', async () => {
  const a = baseArgs(true);
  const res = makeResult(['ok'], [], { language_request: 'Spanish' });
  await processConvoResult({ ...a, res, textToSend: 'we talk in english now' });

  assert.deepEqual(await slot(a.handle), { fact: undefined, pref: undefined });
  assert.equal(languageReceipts().length, 0);
});

// ── A1 regression, kept beside the wiring it shares a dispatch with ──────────

test('an invented tapback type is dropped, not written into the transcript', async () => {
  const a = baseArgs();
  const res = makeResult([], [{ name: 'send_reaction', input: { type: 'wave' } }]);
  const out = await processConvoResult({ ...a, res, textToSend: 'nice' });

  assert.equal(out.reaction, null);
  const msgs = await getConversation(a.chatId);
  assert.ok(!msgs.some(m => m.content.startsWith('[reacted with')), 'no history line for a non-tapback');
});
