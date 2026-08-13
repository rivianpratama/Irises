import { callLLM } from '../../llm/callLLM.js';
import { transcribeAudio } from '../../llm/transcribe.js';
import {
  REACTION_TOOL, REMEMBER_USER_TOOL, DELEGATE_TO_OPS_TOOL,
  RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL, SET_PREFERENCE_TOOL,
  SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
  UPDATE_MEMORY_TOOL,
} from './tools.js';
import { rememberMedia } from './mediaRecall.js';
import { getPreference, ensureChatId, clearDossier } from '../../db/repositories/memory.js';
import { memoryHandle, isGroupHandle } from '../../memory/identity.js';
import { retractAllForHandle } from '../../db/repositories/memoryMedium.js';
import { expireShortTermNow } from '../../db/repositories/memoryShort.js';
import { getLongDoc, saveLongDoc } from '../../db/repositories/memoryLong.js';
import { buildContextBlock } from '../../memory/dossier.js';
import { getActiveOps } from '../../state/opsCoordination.js';
import { getConversation, addMessage, clearConversation, clearUserProfile } from '../../state/conversation.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import { hasMedia, type IncomingMedia } from '../../webhook/types.js';
import { reportError } from '../../diagnostics/errorLog.js';
import type { LlmMessage, LlmToolDef } from '../../llm/types.js';
import { buildSystemPrompt, convoPersonaChars, processConvoResult, formatHistory, emptyExtras, callConvoLLM, annotateTappedReply } from './shared.js';
import { voiceOutcome } from '../fallfirm/client.js';
import { helpText } from '../fallfirm/floor.js';
import type { ChatContext, ChatResponse, Reaction } from './shared.js';

// Shared front-line types/helpers live in ./shared.js. Re-export the types so existing imports of
// `./convo/client.js` still resolve.
export type {
  StandardReactionType, ReactionType, Reaction,
  ChatContext, ImageInput, AudioInput, ChatResponse,
} from './shared.js';

/**
 * The Convo model doesn't receive the file bytes itself, so a media turn gets a bracketed text note
 * telling it a file arrived and to open it via a delegated look (its own eyes — see the Attachments
 * section of Context.md). The note is framed as "open it to look", NEVER "you can't see it": Irises
 * must never tell the user she can't see/read a file. Audio is folded in as a transcript (the cheap
 * fast path) UNLESS transcription failed, in which case the note flags the voice memo for a listen.
 * The note rides textToSend so it persists in history and the model sees it every turn.
 */
function describeAttachments(media: IncomingMedia, opts: { transcriptionFailed: boolean }): string {
  const bits: string[] = [];
  const n = (c: number, one: string, many: string) => (c === 1 ? one : `${c} ${many}`);
  if (media.images.length) bits.push(n(media.images.length, 'a photo', 'photos'));
  if (media.video.length) bits.push(n(media.video.length, 'a video', 'videos'));
  if (media.docs.length) bits.push(n(media.docs.length, 'a document', 'documents'));
  if (opts.transcriptionFailed) bits.push('a voice memo (transcription not folded in yet — delegate a look to listen)');
  if (!bits.length) return '';
  return `[they attached ${bits.join(' + ')} — the contents aren't unpacked into this note. to see/read what's inside, open it with delegate_to_ops (media_scope "this_turn"); that IS you looking. never guess at what's inside before opening it, and NEVER tell them you can't see/open it.]`;
}

export async function chat(
  chatId: string,
  userMessage: string,
  media: IncomingMedia,
  chatContext?: ChatContext,
): Promise<ChatResponse> {
  const cmd = userMessage.toLowerCase().trim();

  if (cmd === '/help') {
    // A deterministic command card, not an outcome — served from the audited floor (see helpText),
    // deliberately NOT routed through Fallfirm, which is instructed to hide system/command names.
    return { text: helpText(), ...emptyExtras() };
  }
  if (cmd === '/clear') {
    await clearConversation(chatId);
    // Voiced AFTER the wipe, so no stale history leaks into it — a clean confirmation.
    return { text: await voiceOutcome({ kind: 'confirmed', summary: 'their conversation with you is cleared — fresh start' }, chatId, memoryHandle(chatContext, chatId)), ...emptyExtras() };
  }
  if (cmd === '/forget me' || cmd === '/forgetme') {
    // Scoped to the MEMORY identity: in a 1:1 that's the sender's own memory (unchanged); in a
    // group it resets the GROUP's shared identity — every memory verb in a group targets the
    // group, and a member wipes their personal memory from their own 1:1 chat.
    const h = memoryHandle(chatContext, chatId);
    if (h) {
      await Promise.all([clearUserProfile(h), clearDossier(h)]);
      // Stage-1 tiers: retract every medium row, expire the short tier, and write an EMPTY long
      // doc as a new revision (history preserved — Stage 3's forgetUser becomes the one sanctioned
      // hard-delete). Best-effort here: a tier hiccup must not block the legacy forget above.
      await Promise.all([
        retractAllForHandle(h).catch(err => console.error('[convo] /forget medium retract failed', err)),
        expireShortTermNow(h).catch(err => console.error('[convo] /forget short expire failed', err)),
        (async () => {
          const cur = await getLongDoc(h);
          if (cur?.docMd) await saveLongDoc(h, '', cur.version, 'forget');
        })().catch(err => console.error('[convo] /forget long clear failed', err)),
      ]);
      const summary = isGroupHandle(h)
        ? "this group's shared memory with you is reset — a fresh start for the whole chat (everyone's personal 1:1 memory is untouched)"
        : 'you forgot everything you knew about them';
      return { text: await voiceOutcome({ kind: 'confirmed', summary }, chatId, h), ...emptyExtras() };
    }
    return { text: await voiceOutcome({ kind: 'failed', summary: "couldn't figure out who they are to forget" }, chatId), ...emptyExtras() };
  }

  const history = await getConversation(chatId);
  // Two identities ride every turn: `sender` (the person texting — per-person facilities like
  // profiles and automations) and `handle` (WHOSE MEMORY this turn reads/writes). They are
  // the same in a 1:1; in a GROUP chat the memory identity is the group's own fresh
  // `group:<chatId>` pseudo-handle, so no member's personal memory ever loads into (or is
  // written from) a group conversation.
  const sender = chatContext?.senderHandle;
  const handle = memoryHandle(chatContext, chatId);
  if (handle && !isGroupHandle(handle)) {
    // 1:1 only: prefs.chat_id is a proactive SEND target (engine push deliveries) — a group turn
    // must not repoint it, or a member's private delivery lands in the room.
    void ensureChatId(handle, chatId); // so engine-initiated pushes can reach them
  }
  const [contextBlock, agentTz] = handle
    ? await Promise.all([
        buildContextBlock(handle),
        getPreference<string>(handle, 'agent_tz'),
      ])
    : ['', undefined];

  // Transcribe audio (in parallel) and fold into the text — the cheap fast path for voice memos, so
  // Convo answers them at text-model latency without a background MM read.
  const transcriptionResults = await Promise.all(media.audio.map(a => transcribeAudio(a.url, a.mimeType)));
  const transcriptions = transcriptionResults.filter((t): t is string => Boolean(t));
  const transcriptionFailed = transcriptionResults.some(t => !t);

  let textToSend = userMessage.trim();
  if (transcriptions.length) {
    const t = transcriptions.join('\n');
    textToSend = textToSend ? `[Voice memo transcript: "${t}"]\n\n${textToSend}` : `[Voice memo transcript: "${t}"]\n\nRespond naturally.`;
  }

  // The Convo model doesn't receive the raw image/video/doc bytes (or a memo whose transcription
  // failed). A bracketed note tells it a file arrived and to open it via delegate_to_mm; on a
  // caption-less media turn the note stands in as the whole message so the model still has something
  // to act on. Framed as "open it to look", never "you can't see it" — Irises never disclaims sight.
  const attachNote = describeAttachments(media, { transcriptionFailed });
  if (attachNote) textToSend = textToSend ? `${textToSend}\n\n${attachNote}` : attachNote;

  // If they tapped reply on an earlier message, fold that context into the message itself so it
  // persists in history and reaches the API — not just this turn's system prompt. Thread-aware:
  // one of Irises's bubbles, the user's own thread root, or an honest unresolved marker.
  const repliedTo = chatContext?.repliedTo ?? (chatContext?.repliedToText ? { kind: 'assistant' as const, text: chatContext.repliedToText } : undefined);
  if (textToSend) textToSend = annotateTappedReply(textToSend, repliedTo);

  if (textToSend) await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);

  const tools: LlmToolDef[] = [
    REACTION_TOOL, REMEMBER_USER_TOOL, DELEGATE_TO_OPS_TOOL, SET_PREFERENCE_TOOL,
    SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
    UPDATE_MEMORY_TOOL,
  ];
  if (chatContext?.isGroupChat) tools.push(RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL);

  // Label the current turn with when it actually ARRIVED, not lock-acquisition time — a message that
  // queued behind the chat lock (while a follow-up delivered) would otherwise read as arriving after
  // bubbles it actually preceded. arrivals[0] is the earliest text-bearing message (queue order). The
  // DB record time is untouched (see addMessage above) so record order = lock order stays single-clock.
  const arrivedAt = chatContext?.arrivals?.[0]?.receivedAt ?? 0;
  const messages: LlmMessage[] = [
    ...formatHistory(history, chatContext?.isGroupChat ?? false),
    // Text-only: Convo never ingests media natively — that's MM's job.
    { role: 'user', timestamp: timestampLabel(arrivedAt > 0 ? arrivedAt : Date.now()) || undefined, content: textToSend || '...' },
  ];

  // Synchronous read of what Ops is working on for this chat RIGHT NOW (in-memory, race-free).
  const activeOps = getActiveOps(chatId);

  try {
    const res = await callConvoLLM({
      role: 'convo',
      system: buildSystemPrompt(chatContext, contextBlock, activeOps, undefined, tools, history, textToSend, agentTz || undefined),
      // The persona is the stable HEAD of that system string; mark its length so the Anthropic lane
      // caches the persona across turns instead of cache-writing the whole per-turn-varying system.
      systemCachePrefixLen: convoPersonaChars(),
      tools,
      jsonBubbles: true,   // force the schema-valid envelope at the API on BOTH providers
      toolsViaJson: true,  // tools are WRITTEN into that envelope (tool_calls), never sent natively
      messages,
      trace: { chatId, handle, label: 'convo' },
    });
    const result = await processConvoResult({ res, chatId, handle, chatContext, textToSend, history, media });
    // Stash this turn's media for a LATER text follow-up to recall (delegate_to_mm media_scope
    // "earlier"). Written AFTER processConvoResult so an "earlier" recall THIS turn still resolves to
    // the PRIOR file — writing it before would let a new-media turn that references an earlier file
    // recall the file just sent. URLs + mimeTypes only; overwrites the last stash.
    if (handle && hasMedia(media)) void rememberMedia(handle, chatId, media);
    return result;
  } catch (error) {
    console.error('[convo] API error:', error);
    throw error;
  }
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

export async function getGroupChatAction(message: string, sender: string, chatId: string): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const history = await getConversation(chatId);
  const recent = history.slice(-4).map(m => (m.role === 'assistant' ? `Irises: ${m.content}` : `${m.handle || 'Someone'}: ${m.content}`)).join('\n');
  try {
    const res = await callLLM({
      role: 'classify',
      maxTokens: 20,
      system: `Classify how the assistant "Irises" should handle a group-chat message. Reply with one of: "respond" (default when addressed/asked/mentioned or unsure), "react:like" / "react:love" / "react:laugh" (brief ack only), or "ignore" (human-to-human, not about Irises).`,
      messages: [{ role: 'user', content: `${recent ? `Recent:\n${recent}\n\n` : ''}New from ${sender}: "${message}"\n\nHow should Irises handle this?` }],
      trace: { chatId, handle: sender, label: 'classify' },
    });
    const answer = (res.text || 'ignore').toLowerCase().trim();
    if (answer.includes('respond')) return { action: 'respond' };
    if (answer.includes('react')) {
      const reaction: Reaction = answer.includes('love') ? { type: 'love' } : answer.includes('laugh') ? { type: 'laugh' } : { type: 'like' };
      return { action: 'react', reaction };
    }
    return { action: 'ignore' };
  } catch (error) {
    console.error('[convo] groupChatAction error:', error);
    // 'ignore' is the safe default, but it is indistinguishable from a deliberate stay-out: a
    // classifier that fails every call makes Irises go silently mute in the room with nothing durable
    // saying why. Reported so the mute is visible.
    reportError({ source: 'convo', category: 'classifier_failure', severity: 'warn', err: error, chatId });
    return { action: 'ignore' };
  }
}

/** Irises does not generate images; stub keeps the webhook-handler contract type-safe. */
export async function generateImage(_prompt: string): Promise<string | null> {
  return null;
}
