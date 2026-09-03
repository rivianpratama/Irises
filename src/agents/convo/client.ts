import { callLLM } from '../../llm/callLLM.js';
import { transcribeAudio } from '../../llm/transcribe.js';
import {
  REACTION_TOOL, rememberUserTool, delegateToOpsTool,
  RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL, setPreferenceTool,
  SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
  UPDATE_MEMORY_TOOL, UPDATE_SELF_TOOL, RECALL_MEMORY_TOOL,
} from './tools.js';
import { selfUpdateEnabled } from '../../update/selfUpdate.js';
import { rememberMedia } from './mediaRecall.js';
import { getPreference, ensureChatId, clearDossier } from '../../db/repositories/memory.js';
import { memoryHandle, isGroupHandle } from '../../memory/identity.js';
import { retractAllForHandle } from '../../db/repositories/memoryMedium.js';
import { deleteShortTermForHandle } from '../../db/repositories/memoryShort.js';
import { purgeArchiveFor } from '../../db/repositories/memoryArchive.js';
import { getLongDoc, saveLongDoc } from '../../db/repositories/memoryLong.js';
import { buildContextBlockWithHot } from '../../memory/dossier.js';
import { memoryRelevanceEnabled, shortEntryLabel, threadHit } from '../../memory/relevance.js';
import { renderedTurnFocusHits, type TurnFocusHit, type TurnFocusInput } from './turnFocus.js';
import { getActiveOps } from '../../state/opsCoordination.js';
import { getConversation, addMessage, clearConversation, clearUserProfile } from '../../state/conversation.js';
import { getEngineBackend, withEngineSlot } from '../ops/engineBackend.js';
import { pendingIntroWeave } from '../ops/firstMove.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import { getAffectState } from '../../db/repositories/affectState.js';
import {
  getRelationshipClimate, clearRelationshipClimate, relationshipClimateEnabled,
} from '../../db/repositories/relationshipClimate.js';
import { clearThreadInventory } from '../../db/repositories/threadInventory.js';
import { pickThreadForTurn, type ThreadTurn } from '../../memory/threadHarvest.js';
import { defaultClimate } from '../../persona/climate.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { cycleAnchorMs } from '../../persona/config.js';
import type { ComputedState } from '../../persona/status.js';
import { hasMedia, type IncomingMedia } from '../../webhook/types.js';
import { reportError } from '../../diagnostics/errorLog.js';
import type { LlmMessage, LlmRequest, LlmResult, LlmToolDef } from '../../llm/types.js';
import { buildSystemPromptSections, processConvoResult, formatHistory, emptyExtras, callConvoLLM, annotateTappedReply } from './shared.js';
import { voiceOutcome } from '../fallfirm/client.js';
import { helpText } from '../fallfirm/floor.js';
import { claimPendingUpdateNote } from '../../update/announce.js';
import type { ChatContext, ChatResponse, Reaction } from './shared.js';
import type { CraftTurnFacts } from './personaModules.js';

// Shared front-line types/helpers live in ./shared.js. Re-export the types so existing imports of
// `./convo/client.js` still resolve.
export type {
  StandardReactionType, ReactionType, Reaction,
  ChatContext, ImageInput, AudioInput, ChatResponse,
} from './shared.js';

/** How long a quiet stretch has to be before this turn counts as an OPENING — the same half hour
 *  the threading engine treats as the start of a conversation rather than the middle of one. */
export const UPDATE_NOTE_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * May the one-off version note be claimed on this turn? PURE.
 *
 * The claim is one-shot per chat per version, so WHERE it is claimed decides whether the note
 * interrupts: taken three messages into a live back and forth it spends itself on the turn where
 * "by the way, you have an upgrade waiting" arrives instead of an answer. An opening is a real
 * quiet stretch before this message, or their very first message ever — and an unclaimed note is
 * not a lost note, it is simply still waiting at the next one.
 */
export function updateNoteOpening(gapMs: number, historyRows: number): boolean {
  return historyRows === 0 || gapMs >= UPDATE_NOTE_MIN_GAP_MS;
}

/**
 * The Convo model doesn't receive the file bytes itself, so a media turn gets a bracketed text note
 * telling it a file arrived and to open it via a delegated look (its own eyes — see the attachments
 * craft page, convo/craft/attachments.md). The note is framed as "open it to look", NEVER "you can't
 * see it": Irises must never tell the user she can't see/read a file. Audio is folded in as a
 * transcript (the cheap fast path) UNLESS transcription failed, in which case the note flags the
 * voice memo for a listen. The note rides textToSend so it persists in history and the model sees it
 * every turn.
 *
 * Whether this note came back is ALSO the gate on that craft page (personaModules.ts), plumbed
 * through `craftFacts` at the assembler call below: the page and the note arrive together.
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
  /**
   * The front-line model call, injectable for tests only (the repo's DI convention: `callLLM`'s own
   * `run`, `splitMiss`'s llm, the engine-backend stubs). Production callers pass nothing and get
   * `callConvoLLM`, unchanged.
   *
   * It exists because everything between the memory read and the reply — the relevance router
   * handed to the routing gate, the turn-focus hits, the receipt — is assembled HERE and nowhere
   * else, so a test that starts at `processConvoResult` cannot see any of it. The same function is
   * handed to `turn.call` below, so the retry ladders use the fake too.
   */
  call?: (req: LlmRequest) => Promise<LlmResult>,
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
      // Stage-1 tiers: retract every medium row, DELETE the short tier, purge the cold archive,
      // and write an EMPTY long doc as a new revision (head history preserved — Stage 3's
      // forgetUser becomes the one sanctioned hard-delete of the revisions themselves).
      // Best-effort here: a tier hiccup must not block the legacy forget above.
      //
      // The short tier is deleted, NOT expired: an expiry would leave the rows to be swept 48h
      // later, and the sweep ARCHIVES what it sweeps — a forget that reappears in recall two days
      // on. Same reason the archive is purged for both the handle and this chat.
      //
      // ORDER IS LOAD-BEARING. Retraction ARCHIVES what it retracts (appendArchive), and the purge
      // below is what removes those rows. Run concurrently, the purge's synchronous DELETE lands
      // first and the retraction's INSERT lands after it — the forgotten notes survive in the
      // searchable archive and come straight back through recall_memory.
      await retractAllForHandle(h).catch(err => console.error('[convo] /forget medium retract failed', err));
      await Promise.all([
        deleteShortTermForHandle(h).catch(err => console.error('[convo] /forget short delete failed', err)),
        (async () => {
          const cur = await getLongDoc(h);
          if (cur?.docMd) await saveLongDoc(h, '', cur.version, 'forget');
        })().catch(err => console.error('[convo] /forget long clear failed', err)),
        // Climate is cleared deliberately: the standing register is an accreted read of THIS person,
        // so it is exactly the kind of thing a forget means. (affect_state surviving /forget is a
        // known, separate quirk of its chat keying — do not "fix" it here.)
        clearRelationshipClimate(h).catch(err => console.error('[convo] /forget climate clear failed', err)),
        // Same reasoning for the thread inventory: the themes and open loops are an accreted read of
        // THIS person — what they keep circling back to and what they left hanging — which is
        // exactly the kind of thing a forget means. It also takes the ping budget stamp with it,
        // so a wiped handle starts the week fresh.
        clearThreadInventory(h).catch(err => console.error('[convo] /forget threads clear failed', err)),
      ]);
      // LAST: nothing may archive after this. (The medium retraction above is the only archive
      // writer on this path; the short tier hard-DELETEs and the long doc writes a revision.)
      await purgeArchiveFor({ handle: h, chatId }).catch(err => console.error('[convo] /forget archive purge failed', err));
      // The engine holds its own user model for this chat's session — ASK it to forget too
      // (same request channel as update_memory; the engine owns the decision). Fire-and-forget:
      // an engine hiccup must not block the local wipe that already happened.
      // Through the engine slot, like the update_memory ask in shared.ts: remember() is a full agent
      // run on the engine, so an unmetered one issued while two delegations are in flight can trip
      // the engine's concurrent-run cap and 429 work the user is actually waiting on.
      const engine = getEngineBackend();
      if (engine) {
        void withEngineSlot(() => engine.remember(chatId, h,
          'The user asked to be forgotten. Please remove or disregard everything you hold in memory about this user.',
        )).catch(err => console.warn('[convo] /forget engine forget-ask failed', err));
      }
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
  const [context, agentTz, climate] = handle
    ? await Promise.all([
        // Pass the current turn text so the short-tier renderer can gate whether the freshest research
        // look renders in full (on-topic follow-up) or collapses to a settled digest line (topic moved on).
        // The WithHot variant also reports which look that was, so the turn-focus block can name it.
        buildContextBlockWithHot(handle, userMessage),
        getPreference<string>(handle, 'agent_tz'),
        // The weeks-scale standing register with THIS identity (climate.ts). Handle-keyed like the
        // memory tiers beside it, unlike the chat-keyed affect read below. Defaults when there's no
        // identity to key on, and a default climate renders nothing at all.
        // Two structural gates, both resolving to the default register (i.e. to nothing rendered):
        // the feature flag, and a GROUP identity — the eval never runs for a group, so a group row
        // can only exist as legacy or hand-written data, and "a group has no standing register" is
        // a property worth stating here rather than inheriting from what the writer happens to skip.
        relationshipClimateEnabled() && !isGroupHandle(handle)
          ? getRelationshipClimate(handle)
          : Promise.resolve(defaultClimate()),
      ])
    : [{ block: '', hotLook: null, turn: null, gates: {}, craft: {} }, undefined, defaultClimate()];
  const contextBlock = context.block;

  // Irises's hidden affect state: her persisted prior-turn mood/gauges/meta-prompt for THIS chat,
  // plus the clock-computed cycle/circadian baseline for right now (anchored to the user's tz).
  // Feeds the "internal weather" prompt block and is re-merged with the model's emitted status
  // after the reply. Never user-visible.
  const affectState = await getAffectState(chatId);
  const nowMs = Date.now();
  const computed: ComputedState = {
    cycle: computeCycle(nowMs, cycleAnchorMs()),
    circadian: computeCircadian(nowMs, agentTz || undefined),
  };

  // Transcribe audio (in parallel) and fold into the text — the cheap fast path for voice memos, so
  // Convo answers them at text-model latency without a background file read.
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

  // ONE engine read for the turn: it picks the delegate tool's lane, gates the reminder tools, and
  // feeds the capability summary further down — all three must agree on the same engine.
  const engine = getEngineBackend();
  const engineName = engine?.name ?? null;
  // Order is load-bearing and must stay exactly as it is on the hermes lane: it drives the tool-docs
  // section and the JSON envelope's name enum + flat args union (first tool's description wins), so
  // the reminder tools are gated IN PLACE rather than appended.
  const tools: LlmToolDef[] = [
    REACTION_TOOL, rememberUserTool(), delegateToOpsTool(engineName), setPreferenceTool(),
    // Reminders live entirely on the engine (see shared.ts: all three tools route to
    // createReminder/listReminders/cancelReminder, with no local scheduler behind them). OpenClaw's
    // aren't wired — create and cancel throw, list is always empty — so offering them there buys the
    // user a confirmed reminder that never fires. Gated as a set: listing and canceling mean nothing
    // when nothing can be created.
    ...(engineName === 'openclaw' ? [] : [SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL]),
    CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
    UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL,
  ];
  if (chatContext?.isGroupChat) tools.push(RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL);
  // "update yourself" from chat — offered only when enabled (single-user by design; see selfUpdate.ts).
  if (selfUpdateEnabled()) tools.push(UPDATE_SELF_TOOL);

  // Label the current turn with when it actually ARRIVED, not lock-acquisition time — a message that
  // queued behind the chat lock (while a follow-up delivered) would otherwise read as arriving after
  // bubbles it actually preceded. arrivals[0] is the earliest text-bearing message (queue order). The
  // DB record time is untouched (see addMessage above) so record order = lock order stays single-clock.
  const arrivedAt = chatContext?.arrivals?.[0]?.receivedAt ?? 0;
  const messages: LlmMessage[] = [
    ...formatHistory(history, chatContext?.isGroupChat ?? false),
    // Text-only: Convo never ingests media natively — the engine opens files.
    { role: 'user', timestamp: timestampLabel(arrivedAt > 0 ? arrivedAt : Date.now()) || undefined, content: textToSend || '...' },
  ];

  // Synchronous read of what Ops is working on for this chat RIGHT NOW (in-memory, race-free).
  const activeOps = getActiveOps(chatId);

  // `gapMs` is the real opening before this message. It gates two things, for the same reason: the
  // loop stage below (a reopening callback belongs at the START of a conversation) and the version
  // note just under here.
  //
  // The stored rows carry `at`, but the type allows it to be absent (older rows, hand-built
  // fixtures), and an absent or non-finite stamp must read as "no idea how long it's been" — which
  // is Infinity, the value that makes both gates PASS. That is the right direction: a loop still has
  // to clear quiet-since-capture, the cooldown, the present-topic check and the turn/day budgets,
  // and treating an undated thread as mid-conversation would silently disable the callback on any
  // install whose history predates the stamps.
  const lastAt = history.length ? history[history.length - 1].at : undefined;
  const gapMs = typeof lastAt === 'number' && Number.isFinite(lastAt) ? nowMs - lastAt : Infinity;

  // If a version update is pending and this chat hasn't been told yet, weave a one-off mention into
  // this reply (claimed once per chat per version — this suppresses the cold proactive push for it).
  // Only at an OPENING: the claim is one-shot, so claiming it three messages into a live back and
  // forth spends it on the turn where "by the way, you have an upgrade waiting" arrives instead of
  // an answer. Mid-conversation the claim is left unconsumed and the note waits — it is still there
  // at the next real opening, which comes around within the hour.
  // Read ONCE for the turn: the gate and the receipt that reports it must not be able to disagree
  // because someone flipped the env between two calls.
  const gatesOn = memoryRelevanceEnabled();
  const updateOpening = !gatesOn || updateNoteOpening(gapMs, history.length);
  const updateNote = updateOpening ? claimPendingUpdateNote(chatId) : null;

  // What the active engine can actually do this deployment (closed vocabulary). Read INSTANTLY from
  // the backend's cached summary — this returns synchronously and never triggers a blocking fetch (the
  // adapter refreshes in the background), so it adds no latency to the turn. null when no engine, when
  // the backend doesn't do capability discovery, or before the first refresh has answered.
  const capabilitySummary = engine?.getCapabilitySummary?.() ?? null;

  // At most ONE standing thread of theirs to put in front of her this turn — an open loop worth a
  // plain "how did it go", or a theme that has earned a light tag — chosen, budgeted and billed by
  // pure code (memory/threadHarvest.ts → persona/threads.ts). Awaited: it is a single indexed row
  // read, and its output shapes the system prompt built on the next line. `gapMs` — the loop stage's
  // hard gate — is computed above, beside the other gate that reads it.
  const thread: ThreadTurn = handle && !isGroupHandle(handle)
    ? await pickThreadForTurn(handle, affectState, { incomingText: textToSend, gapMs, chatId })
    : { offer: null, outcomeAsk: null };

  // The install introduction, when this turn is the very first word they have ever sent her: the
  // first-move machine couldn't text them proactively (no confirmed history on that chat, or no
  // channel at all), so her reply to their own opener carries it instead. Awaited here rather than
  // inside buildSystemPrompt because it can re-key the seeded memory onto the handle that actually
  // texted — a store write, and the prompt assembler is synchronous. Null on every turn but one,
  // ever, from a cached state read; a group handle never gets it.
  const introWeave = handle ? await pendingIntroWeave(handle) : null;

  // What this turn is ABOUT, for the block that goes last inside <prompt> (convo/turnFocus.ts):
  // their message, plus the held things that touch it. Nothing is re-derived here — the relevance
  // router already scored every held channel during the memory read (memory/relevance.ts), and the
  // standing thread arrives through its own door because the thread engine picks its offer AFTER
  // that read (see threadHit, and the sequencing note on buildContextBlockWithHot).
  //
  // The offer leads, and not because it scored best: it is the one item here that was CHOSEN for
  // this turn rather than merely found, and a loop is offered precisely when it is off-topic. The
  // router's own hits follow, best first; the block prints the first two.
  //
  // With CONVO_MEMORY_RELEVANCE off there is no router, and the block falls back to P0's two
  // sources — the offer plus the one research look the memory stack rendered in FULL — so the
  // prompt is byte-identical to an install that never had P2.
  const hits: TurnFocusHit[] = context.turn
    ? [
        ...(thread.offer ? [threadHit(context.turn, thread.offer.label)] : []),
        ...context.turn.hits,
      ].map(h => ({ label: h.label, source: h.kind }))
    : [
        ...(thread.offer ? [{ label: thread.offer.label, source: 'thread' as const }] : []),
        ...(context.hotLook ? [{ label: shortEntryLabel(context.hotLook), source: 'research' as const }] : []),
      ];
  const turnFocus: TurnFocusInput = { text: textToSend, hits };

  // Held in a variable (not inlined): recall_memory's second pass re-invokes the model with this
  // SAME system + messages, minus the recall tool (see processConvoResult).
  //
  // The measuring variant of the assembler, for the same string plus a per-section size table — the
  // sizes are what the turn receipt reports, and they are free here (`prompt.system` is the
  // byte-identical output buildSystemPrompt returns, which is now just a wrapper over this call;
  // see convo/promptSections.ts).
  // The three structural facts behind the craft-module gates (convo/personaModules.ts), none of them
  // re-derived: the attachment note this turn's text already carries, and the two reads the memory
  // loaders answered on the way past (memory/dossier.ts). Everything else a gate needs — the
  // reply-order read, the burst, the tapped reply, the tool list — the assembler is already holding.
  const craftFacts: CraftTurnFacts = { ...context.craft, attachmentNote: !!attachNote };
  const prompt = buildSystemPromptSections(chatContext, contextBlock, activeOps, updateNote ?? undefined, tools, history, textToSend, agentTz || undefined, affectState, computed, capabilitySummary, climate, thread, introWeave, turnFocus, craftFacts);
  const system = prompt.system;

  try {
    const res = await (call ?? callConvoLLM)({
      role: 'convo',
      system,
      // Where that system string's stable prefixes end — the persona head, then the tool docs and
      // craft pages, which change only when this chat's tools or gates do. The Anthropic lane caches
      // each of them instead of cache-writing the whole per-turn-varying system every call. Read off
      // the sizes the assembler just reported, so no part of the string is measured twice.
      systemCacheBreakpoints: prompt.cacheBreakpoints,
      tools,
      jsonBubbles: true,   // force the schema-valid envelope at the API on BOTH providers
      toolsViaJson: true,  // tools are WRITTEN into that envelope (tool_calls), never sent natively
      messages,
      trace: { chatId, handle, label: 'convo' },
    });
    const result = await processConvoResult({
      res, chatId, handle, chatContext, textToSend, history, media,
      turn: { system, messages, tools, call, cacheBreakpoints: prompt.cacheBreakpoints },
      computed,
      introWoven: !!introWeave,
      // The turn's ONE relevance verdict, already built during the memory read above — the routing
      // gate reads it so it can stop discarding an answer she held the source for, and a delegation
      // carries those hits into its brief. Null with CONVO_MEMORY_RELEVANCE off, which is the gate's
      // pre-P2 text-only behavior.
      relevance: context.turn,
      // What was in front of the model this turn, for its one receipt (diagnostics/turnTrace.ts).
      // Every value here is already computed above — nothing is re-derived, nothing is re-read, and
      // no prompt text travels: the assembler's own section sizes, the verdicts the pre-turn reads
      // already made, and the hit labels the turn-focus block rendered.
      trace: {
        prompt,
        messages,
        gates: {
          // The selection engine's accounting, straight off the pre-turn read. Null when selection
          // never ran (threading off, or a group identity — a room has no threads of its own).
          threads: thread.report ?? null,
          // Whether the freshest held look is in front of her in FULL (it touched this message), or
          // only as its settled digest line, or whether no memory rendered at all — plus everything
          // else the stack held that touched the message, which is the reading that says whether a
          // full memory stack had anything to do with what she was asked.
          memory: {
            shortHotLook: context.hotLook ? 'full' : contextBlock ? 'digest' : 'none',
            hits: (context.turn?.hits ?? []).map(h => ({ label: h.label, kind: h.kind })),
            // What the gate table did with each block it rendered, straight off the renderers that
            // decided it (memory/wrappers.ts). Empty with CONVO_MEMORY_RELEVANCE off — no gate ran.
            // The version note's row is added here because this is where that one is decided.
            blocks: gatesOn
              ? {
                  ...context.gates,
                  update_note: updateOpening
                    ? { verdict: updateNote ? 'full' : 'dropped', reason: updateNote ? 'gap_open' : 'nothing_held' }
                    : { verdict: 'dropped', reason: 'mid_conversation' },
                }
              : context.gates,
          },
          extras: { updateNote: !!updateNote, introWeave: !!introWeave, activeOps: activeOps.length },
        },
        // What the block actually PRINTED, asked of the block itself rather than re-derived: the
        // whole ranked set rides on gates.memory.hits above, and the two receipts read as a pair —
        // what she was shown, against what there was to show.
        hits: renderedTurnFocusHits(hits).map(h => h.label),
      },
    });
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
