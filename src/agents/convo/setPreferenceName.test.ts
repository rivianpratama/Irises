// Coverage for the set_preference key='name' route. Both the persona and the tool schema
// advertise that key, but the name every prompt RENDERS is user_profiles.name — nothing has ever
// read prefs.name — so a model that reached for set_preference instead of remember_user watched
// its write vanish into a dead slot. The dispatch now routes 'name' to the profile and purges any
// stale prefs.name the old path left. Runs end-to-end against the ephemeral DB backend.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getUserProfile } from '../../db/repositories/profiles.js';
import { getMemory, setPreference } from '../../db/repositories/memory.js';
import { groupHandle } from '../../memory/identity.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function setPref(key: string, value: unknown): LlmToolCall {
  return { name: 'set_preference', input: { key, value } };
}

let seq = 0;
function freshHandle(): string {
  return `+1555600${(seq++).toString().padStart(4, '0')}`;
}

function args(over: Partial<ChatContext> = {}) {
  __resetOpsCoordination();
  const sender = freshHandle();
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender, ...over };
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
}

test("set_preference key='name' writes the PROFILE, not a dead pref", async () => {
  const a = args();
  const res = makeResult(['nice to meet you, ace'], [setPref('name', 'Ace')]);
  await processConvoResult({ ...a, res, textToSend: 'call me ace' });

  assert.equal((await getUserProfile(a.handle))?.name, 'Ace');
  const prefs = (await getMemory(a.handle))?.prefs ?? {};
  assert.ok(!('name' in prefs), 'nothing is left in the slot nothing reads');
});

test("a stale prefs.name from the old path is purged on the next name write", async () => {
  const a = args();
  await setPreference(a.handle, 'name', 'Stale');
  await setPreference(a.handle, 'agent_tz', 'America/Denver');
  assert.equal((await getMemory(a.handle))?.prefs.name, 'Stale');

  const res = makeResult(['got it'], [setPref('name', 'Ace')]);
  await processConvoResult({ ...a, res, textToSend: 'actually call me ace' });

  const prefs = (await getMemory(a.handle))?.prefs ?? {};
  assert.ok(!('name' in prefs));
  assert.equal(prefs.agent_tz, 'America/Denver', 'the other prefs survive the purge');
  assert.equal((await getUserProfile(a.handle))?.name, 'Ace');
});

test('other keys still take the ordinary prefs route', async () => {
  const a = args();
  const res = makeResult(['noted'], [setPref('agent_tz', 'America/Chicago')]);
  await processConvoResult({ ...a, res, textToSend: "i'm in chicago" });
  assert.equal((await getMemory(a.handle))?.prefs.agent_tz, 'America/Chicago');
  assert.equal(await getUserProfile(a.handle), null, 'no profile row minted for a non-name key');
});

test('a GROUP identity never gets a person-profile name (falls through to prefs)', async () => {
  const chatId = randomUUID();
  const a = args({ isGroupChat: true, participantNames: ['+15550001111'] });
  const gh = groupHandle(chatId);
  const res = makeResult(['ok'], [setPref('name', 'The A-Team')]);
  await processConvoResult({ ...a, chatId, handle: gh, res, textToSend: 'call us the a-team' });

  assert.equal(await getUserProfile(gh), null, 'a group is not a person — no profile write');
  assert.equal((await getMemory(gh))?.prefs.name, 'The A-Team');
});
