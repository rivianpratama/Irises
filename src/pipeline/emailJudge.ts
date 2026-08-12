// Instant email discernment. Replaces the old triage->auto-schedule pipeline: a new email
// triggers the Judge (Sonnet) the moment it arrives (Gmail push -> src/webhook/gmailPush.ts),
// and if it matters the Judge's voiced flag is sent straight to the agent. Reminders are no
// longer auto-scheduled — the Judge OFFERS one, and Convo sets it only if the agent says yes.
//
// The daily digest pass (runDailyJudgePass) judges a batch of unread emails and synthesizes
// one consolidated, human-like message via an LLM call — greeting, core summary, light CTA —
// capped at 5 bubbles (1-2 ideal, 3 ok). The per-email judge calls do the hard reasoning;
// the synthesis step handles voice/consolidation.
//
// Triggers that call in here:
//   - the Gmail push webhook (per-handle, on a real-time notification)
//   - onConnected (backfill: just (re)initialize the watermark; we don't ping about old mail)
//   - a slow backstop poll (catches any dropped push notifications)
import { fetchInbox, listNewMessageIds, fetchMessagesByIds, fetchRecentSent, stopWatch, type DealEmail } from '../services/gmail.js';
import { judgeEmail, type JudgeVerdict } from '../agents/judge/client.js';
import { callLLM } from '../llm/callLLM.js';
import { loadContext } from '../agents/loadContext.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { parseReply } from './bubbleJson.js';
import { redactInternalTools } from '../agents/guardrails.js';
import { renderUserMemory } from '../memory/wrappers.js';
import { loadMediumBundle } from '../memory/mediumTerm.js';
import { getLongDoc } from '../db/repositories/memoryLong.js';
import { createAutomation } from '../db/repositories/automations.js';
import { getMemory, setPreferences } from '../db/repositories/memory.js';
import { addShortTerm, listShortTerm } from '../db/repositories/memoryShort.js';
import { PENDING_EMAIL_TTL_MS } from '../memory/shortTerm.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { getConversation } from '../state/conversation.js';
import { listConnectedHandles } from '../db/repositories/tokens.js';
import { upsertEmails } from '../db/repositories/emails.js';
import { GmailReauthRequired } from '../oauth/google.js';
import { startWatchForHandle } from './gmailWatch.js';
import { DEFAULT_TZ, inQuietHours } from './zonedTime.js';
import { daypart, hourInZone } from './chatTime.js';
import { scopeHistoryToUser } from '../memory/transcript.js';
import { reportError } from '../diagnostics/errorLog.js';

const POLL_MAX = Number(process.env.EMAIL_POLL_MAX || 25);
const BACKSTOP_INTERVAL_MS = Number(process.env.EMAIL_BACKSTOP_INTERVAL_MS || 60 * 60 * 1000); // hourly safety net
const SURFACED_RING = 100; // remember the last N surfaced/judged ids to dedupe duplicate pushes
const PENDING_CONTEXTS = 5; // recent flagged emails kept for Convo to field the follow-up
const DIGEST_RING = 200; // remember the last N digested ids so an email is surfaced at most once, ever
const JUDGE_INACTIVE_MS = Number(process.env.JUDGE_INACTIVE_DAYS || 3) * 24 * 60 * 60 * 1000;

/**
 * Build a structured brief of all important emails for the digest synthesis LLM call.
 * Each entry carries the full From: field (so the LLM can reason about domains for spam/fraud
 * detection), plus summary, severity, deadline, category. The LLM decides what name to show
 * the user — stripping email addresses is its job, not ours.
 */
export function buildDigestBrief(
  important: { email: DealEmail; verdict: JudgeVerdict }[],
  timezone: string,
): string {
  const now = new Date();
  const entries = important.map(({ email, verdict }, i) => {
    const due = verdict.deadlineDate ? `deadline: ${verdict.deadlineLabel ? `${verdict.deadlineLabel} ` : ''}${verdict.deadlineDate}` : 'no deadline';
    return `${i + 1}. from: ${email.from}\n   severity ${verdict.severity}, category ${verdict.category}, ${due}\n   summary: ${verdict.summary}`;
  });
  return [
    `Today is ${now.toISOString()}. The user's timezone is ${timezone}. There are ${important.length} important unread email(s) sitting in their inbox.`,
    '',
    'Here are the important emails, already judged. Your job is to SYNTHESIZE them into a natural, consolidated digest message. You have the full From: field for each email so you can reason about sender domains, but NEVER include email addresses in your message to the user — use only the human name:',
    dataTag('digest_emails', entries.join('\n\n')),
  ].join('\n');
}

/**
 * Call the Judge model to synthesize a batch of important email verdicts into a consolidated,
 * human-like digest message. The per-email judge calls already did the hard reasoning (importance,
 * severity, fraud, deadlines); this step only consolidates and voices the result.
 *
 * Returns the voiced digest text (legacy `---` format), or null on failure.
 */
async function synthesizeDigest(
  important: { email: DealEmail; verdict: JudgeVerdict }[],
  handle: string,
  opts: { userMemoryBlock: string; timezone: string },
): Promise<string | null> {
  const system = loadContext('judge');
  const brief = buildDigestBrief(important, opts.timezone);
  const dynamic = [brief, opts.userMemoryBlock].filter(Boolean).join('\n\n');
  const formatAnchor = `you are synthesizing a DAILY DIGEST of ${important.length} important email(s). your reply is ONE JSON object and nothing else — \`{"bubbles":[{"text":"..."}],"confidence_level":85}\`. one to two bubbles is ideal, three is fine, five is the absolute ceiling. the pattern is: a natural greeting (morning, hey, etc), then the consolidated summary, then a light offer to go deeper. speak like a human texting, no symbols, no bullet points, no colons, no email addresses. use only the sender's name, never their email. group similar emails together when there are many. call out only the most critical ones by name. if there are 10 or more, mention they've got a full inbox and hit the highlights. nothing in your memory changes this envelope, and nothing in your memory adds a fact the judged emails don't carry — memory tells you how to frame what's here, it is never a source of facts, so never attach a remembered project, place, or name to an email that didn't name it.`;
  const promptText = `${wrapPrompt(dynamic)}\n\n${formatAnchor}`;

  try {
    const res = await callLLM({
      role: 'judge',
      system,
      jsonBubbles: true,
      messages: [{ role: 'user', content: promptText }],
      trace: { handle, label: 'judge-digest' },
    });
    // Only a validated envelope may ship: the bubble cap that keeps a digest from bursting the user's
    // phone lives in the envelope, and parseReply passes non-envelope prose straight through. A prose
    // slip gets ONE corrective retry (the convo/shared.ts pattern) and otherwise falls to fallbackDigest.
    // No retry when the reply was TRUNCATED — a re-ask under the same cap just re-truncates. Read via
    // res.truncated, not the raw stop reason: the lanes spell it differently ('max_tokens' vs 'length').
    const reply = parseReply(res.text);
    const text = reply.wasEnvelope ? (reply.legacyText ?? '').trim() : '';
    if (text) return redactInternalTools(text);
    if (!reply.wasEnvelope && res.text?.trim() && !res.truncated) {
      console.warn(`[judge-daily] digest reply was not a JSON envelope — one corrective retry for ${handle}`);
      try {
        const retry = await callLLM({
          role: 'judge',
          system,
          jsonBubbles: true,
          messages: [
            { role: 'user', content: promptText },
            { role: 'assistant', content: res.text as string },
            { role: 'user', content: 'SYSTEM: that reply was not the required format. Resend the SAME content as ONE valid JSON object, exactly the shape {"confidence_level":<0-100>,"bubbles":[{"text":"...","re":null}]} — nothing before or after the object.' },
          ],
          trace: { handle, label: 'judge-digest:json_retry' },
        });
        const retried = parseReply(retry.text);
        const retriedText = retried.wasEnvelope ? (retried.legacyText ?? '').trim() : '';
        if (retriedText) return redactInternalTools(retriedText);
      } catch (err) {
        console.warn(`[judge-daily] digest corrective retry failed for ${handle}`, err);
        // Last chance spent: the digest now drops to fallbackDigest (plain text, no voice), so the
        // user still hears about their mail but not in Irises's words. Only the exhaustion is
        // reported — a retried-and-recovered slip is noise.
        reportError({
          source: 'judge',
          category: 'retry_exhausted',
          severity: 'warn',
          message: 'judge digest corrective retry failed — falling back to the plain-text digest',
          err,
          handle,
        });
      }
    }
    console.warn(`[judge-daily] digest synthesis produced no usable envelope for ${handle}`);
    return null;
  } catch (err) {
    console.error(`[judge-daily] digest synthesis LLM call failed for ${handle}`, err);
    return null;
  }
}

/**
 * Human-readable fallback digest when the synthesis LLM call fails.
 * Plain text, no symbols, structured as greeting + summary + offer. The greeting reads off the
 * USER's clock — the pass is scheduled for their morning, but a retry or a re-timed automation
 * can land at any hour, and "morning" at 9pm is the tell that nobody is home.
 */
export function fallbackDigest(important: { email: DealEmail; verdict: JudgeVerdict }[], timezone: string, nowMs = Date.now()): string {
  // agent_tz is whatever surfaced in conversation ("Eastern", "GMT-5" both land there unvalidated)
  // and Intl throws RangeError on a non-IANA zone. This is the path that guarantees the digest still
  // goes out, so an unusable zone reads off the default clock instead of taking the whole pass down
  // (a throw here escapes runDailyJudgePass before the dedupe ring is persisted).
  let part: string;
  try {
    part = daypart(hourInZone(nowMs, timezone));
  } catch {
    part = daypart(hourInZone(nowMs, DEFAULT_TZ));
  }
  const greeting = part === 'afternoon' || part === 'evening' ? part : part === 'late night' ? 'hey' : 'morning';
  if (important.length === 1) {
    const { verdict } = important[0];
    const due = verdict.deadlineDate ? ` and it's due ${verdict.deadlineDate}` : '';
    return `${greeting}, you got something worth a look${due}\n---\n${verdict.summary}\n---\nlet me know if you want the details`;
  }
  const count = important.length;
  const critical = important.filter(({ verdict }) => verdict.severity === 'critical' || verdict.suspectedFraud);
  if (critical.length) {
    const first = critical[0];
    return `${greeting}, you've got ${count} things in your inbox worth a look and one of them needs attention right away\n---\n${first.verdict.summary}\n---\ni can walk you through the rest whenever you're ready`;
  }
  return `${greeting}, ${count} things came through that are worth a look\n---\ni can break them down for you whenever you're ready`;
}

/** Real-time per-email judging (Gmail push/backstop). Default OFF: judging now runs once daily as a
 *  digest (runDailyJudgePass). Flip JUDGE_REALTIME_ENABLED=true to restore instant per-arrival surfacing. */
function realtimeJudgeEnabled(): boolean {
  return process.env.JUDGE_REALTIME_ENABLED === 'true';
}

// Return widened to unknown: the sender is the mouth (state/mouth.ts), which reports 'sent'/'dropped'.
// The Judge's flags are pre-voiced strings — non-critical ones serialize through the per-chat lock
// (never splitting a live reply); 'critical' (suspected fraud) keeps the documented lock bypass.
type SendFollowUp = (chatId: string, text: string, opts?: { record?: boolean; priority?: 'critical' }) => Promise<unknown>;

// Serialize runs per handle WITHIN this process so a Gmail push and the backstop poll (or two
// pushes) can't both read the same watermark/dedupe-ring and double-surface the same email or
// clobber each other's prefs write. (Deployment is a single VM, so an in-process lock suffices.)
const runLocks = new Map<string, Promise<unknown>>();

/** The flagged-email facts handed to Convo for a "yes, remind me" follow-up (facts, not chat). */
interface PendingContext {
  emailId: string; from: string; subject: string; summary: string;
  severity: string; category: string; deadlineDate: string | null;
  deadlineLabel: string | null; suggestReminder: boolean; surfacedAt: number;
}

function toContext(email: DealEmail, v: JudgeVerdict): PendingContext {
  return {
    emailId: email.id, from: email.from, subject: email.subject, summary: v.summary,
    severity: v.severity, category: v.category, deadlineDate: v.deadlineDate,
    deadlineLabel: v.deadlineLabel, suggestReminder: v.suggestReminder, surfacedAt: Date.now(),
  };
}

/** A plain note Autonome voices when a non-urgent flag is held to morning (quiet-hours opt-in). */
function heldInstruction(v: JudgeVerdict, email: DealEmail): string {
  const what = v.deadlineLabel || v.summary;
  const due = v.deadlineDate ? ` (due ${v.deadlineDate})` : '';
  const offer = v.suggestReminder ? '\noffer to set a reminder if they want one.' : '';
  return `An email came in overnight worth flagging: ${what}${due}\nfrom: "${email.subject}"${offer}`;
}

/**
 * Judge new inbound email for one agent and surface anything important, instantly.
 * Serialized per-handle. On `backfill` (a fresh connect) we only (re)initialize the watermark —
 * we never replay pre-connect mail as "new", which also stops a reconnect flooding the agent.
 */
export function judgeNewEmailsForHandle(
  handle: string,
  sendFollowUp: SendFollowUp,
  opts: { backfill?: boolean; trigger?: 'push' | 'backstop' } = {},
): Promise<void> {
  const prev = runLocks.get(handle) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runJudge(handle, sendFollowUp, opts));
  runLocks.set(handle, next);
  void next.finally(() => { if (runLocks.get(handle) === next) runLocks.delete(handle); });
  return next;
}

// Watch staleness watchdog (Hiver pattern): Gmail watches can die silently before their expiry.
// When the BACKSTOP poll discovers new mail while push has been quiet for hours, the watch is
// presumed dead — reset it (stop + re-watch). Thrash-guarded: at most one reset per window.
const WATCH_WATCHDOG_MS = Number(process.env.GMAIL_WATCH_WATCHDOG_MS || 6 * 60 * 60 * 1000);

async function maybeResetStaleWatch(handle: string, prefs: Record<string, unknown>, discovered: number): Promise<void> {
  if (!process.env.GMAIL_PUBSUB_TOPIC || discovered === 0) return;
  const lastPushAt = Number(prefs.gmail_last_push_at || 0);
  const lastResetAt = Number(prefs.gmail_watch_reset_at || 0);
  if (!lastPushAt) return; // push never delivered yet (fresh watch) — nothing to compare against
  const now = Date.now();
  if (now - lastPushAt < WATCH_WATCHDOG_MS || now - lastResetAt < WATCH_WATCHDOG_MS) return;
  console.warn(`[judge] ${handle}: backstop found ${discovered} email(s) but push has been silent ${Math.round((now - lastPushAt) / 3_600_000)}h — resetting the watch`);
  try {
    await stopWatch(handle).catch(() => {}); // best-effort; a dead watch may already be gone
    await startWatchForHandle(handle);       // renewal path: leaves the advancing cursor alone
    await setPreferences(handle, { gmail_watch_reset_at: now });
  } catch (err) {
    console.error(`[judge] watch reset failed for ${handle}`, err);
  }
}

async function runJudge(handle: string, sendFollowUp: SendFollowUp, opts: { backfill?: boolean; trigger?: 'push' | 'backstop' }): Promise<void> {
  const memory = await getMemory(handle);
  const prefs = memory?.prefs ?? {};
  const targetChat = prefs.chat_id as string | undefined;
  if (!targetChat) {
    console.log(`[judge] no chat_id for ${handle}; skipping`);
    return;
  }

  // A fresh connect (onConnected always passes backfill:true) draws the line at "now": we don't
  // ping about mail that predates the connection, and a reconnect after a gap won't dump backlog.
  if (opts.backfill) {
    await setPreferences(handle, { email_watermark: Date.now(), email_ingested: true });
    console.log(`[judge] ${handle}: drew the watermark line at connect (no backfill ping)`);
    return;
  }

  const watermark = Number(prefs.email_watermark || 0);
  const storedHistoryId = prefs.gmail_watch_history_id as string | undefined;
  const surfaced: string[] = Array.isArray(prefs.surfaced_email_ids) ? (prefs.surfaced_email_ids as string[]) : [];
  const seen = new Set(surfaced);
  const tz = (prefs.agent_tz as string | undefined) || DEFAULT_TZ;
  const respectQuiet = prefs.respect_quiet_hours === true;
  // The Judge's pre-wrapped memory block (own recent flags + the flexible layer, per the
  // agent-tier matrix). Built once per batch from the memory already loaded above + one read
  // per tier, then passed to every email.
  const [profile, medium, ownFlags, longDoc] = await Promise.all([
    getUserProfile(handle),
    loadMediumBundle(handle),
    listShortTerm(handle, { kinds: ['email_flag'], limit: 8 }),
    getLongDoc(handle),
  ]);
  const userCtx = renderUserMemory('judge', {
    profile, memory, medium, short: ownFlags, longDocMd: longDoc?.docMd ?? '',
  });
  // Recent chat, fetched once per batch — passed to the Judge as READ-ONLY context so an
  // important flag surfaced mid-conversation reads as part of the live thread, not a cold barge.
  // It never feeds the verdict (see judge/client.ts renderChatContext).
  const recentHistory = await getConversation(targetChat).catch(() => []);

  // Prefer the incremental history sync (push path); fall back to a watermark scan if the stored
  // historyId is too old (Gmail 404s) or we never had one. On the history path the messages are
  // authoritatively "new" per Gmail, so we DON'T re-apply the internalDate>watermark guard there
  // (that guard is for the time-based fallback only) — the dedupe ring handles duplicates.
  let emails: DealEmail[];
  let fromHistory = false;
  let newHistoryId: string | null = null;
  let fetchGap = false;
  let staleCursor404 = false;
  let reseedHistoryId: string | null = null;
  try {
    if (storedHistoryId) {
      try {
        // Per-run ceiling (JUDGE_RUN_MAX, default 50): a mail storm otherwise means one judge
        // call per email in a single run. Truncated listings return a cursor at the chunk
        // boundary, so the storm drains in bounded chunks across pushes/backstop runs.
        const res = await listNewMessageIds(handle, storedHistoryId);
        newHistoryId = res.newHistoryId;
        if (res.truncated) console.warn(`[judge] ${handle}: history listing truncated at ${res.messageIds.length} ids — cursor committed at the chunk boundary; the rest drains on subsequent runs`);
        const fetched = await fetchMessagesByIds(handle, res.messageIds);
        emails = fetched.emails;
        fetchGap = fetched.hadFetchGap;
        fromHistory = true;
      } catch (err) {
        const status = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
        console.warn(`[judge] ${handle}: history sync failed (status ${status ?? '?'}), falling back to watermark scan`, err);
        if (status === 404) {
          // Stale cursor. Register a fresh watch NOW and CAPTURE its historyId — taken BEFORE the
          // fallback scan below, so the cursor we eventually commit covers mail that arrives DURING
          // this run — but do NOT persist it yet (persistCursor:false); commit it only at the clean
          // checkpoint at the end. We also leave the old (stale) cursor in place rather than blanking
          // it: if this run bails early or holds, the next run re-enters this same 404→fallback path
          // and re-discovers, and a non-blank cursor stops the renewal sweep from seeding "now" over
          // what would otherwise be a tombstone.
          reseedHistoryId = await startWatchForHandle(handle, { persistCursor: false });
          staleCursor404 = true;
        }
        const fb = await fetchInbox(handle, { afterEpochMs: watermark, maxResults: POLL_MAX });
        emails = fb.emails;
        fetchGap = fb.hadFetchGap;
      }
    } else {
      const fb = await fetchInbox(handle, { afterEpochMs: watermark, maxResults: POLL_MAX });
      emails = fb.emails;
      fetchGap = fb.hadFetchGap;
    }
  } catch (err) {
    if (err instanceof GmailReauthRequired) { console.log(`[judge] ${handle} needs Gmail re-auth; skipping`); return; }
    console.error(`[judge] fetch failed for ${handle}`, err);
    return;
  }

  emails.sort((a, b) => a.internalDate - b.internalDate);
  // Every fetched message feeds the local SEARCH index (fire-and-forget; upsertEmails never
  // throws) — this is what makes search_inbox_local complete for all mail that flowed through.
  if (emails.length) void upsertEmails(handle, emails);
  // Backstop-only: mail discovered while push was silent means the watch likely died — reset it.
  if (opts.trigger === 'backstop') void maybeResetStaleWatch(handle, prefs, emails.length);
  let newest = watermark;
  let hadFailure = false;
  let flagged = 0;
  const newContexts: PendingContext[] = [];

  for (const email of emails) {
    // The watermark guard is for the time-based fallback only. On the push/history path Gmail
    // already told us these are new, so we trust the dedupe ring instead (an email whose receive
    // time predates the watermark can still legitimately be new — backdated/re-labeled mail).
    if (!fromHistory && email.internalDate <= watermark) continue;
    if (seen.has(email.id)) continue;
    // Only spend a Sonnet call on mail the agent hasn't already read. On the push/history path an
    // email can be opened on another device in the seconds before we fetch it; the backstop's
    // fetchInbox already filters is:unread, so this is a cheap, authoritative double-check against
    // the current labels at fetch time. Mark it handled (like a "not important" verdict) so the next
    // poll won't reconsider it — no Judge call spent.
    if (!email.labelIds.includes('UNREAD')) {
      seen.add(email.id);
      newest = Math.max(newest, email.internalDate);
      continue;
    }

    // Daily-digest mode (default): the push/backstop path still INDEXES every email (upsertEmails
    // above) so search stays fresh in real time, but it never judges or pings per-arrival — that
    // moved to the once-daily runDailyJudgePass. Mark handled so the watermark advances past it.
    if (!realtimeJudgeEnabled()) {
      seen.add(email.id);
      newest = Math.max(newest, email.internalDate);
      continue;
    }

    const { verdict, message } = await judgeEmail(email, handle, { userMemoryBlock: userCtx, timezone: tz, recentHistory, chatId: targetChat });
    if (!verdict.important || !message) {
      // Nothing to deliver — safe to mark done so we don't re-judge it.
      seen.add(email.id);
      newest = Math.max(newest, email.internalDate);
      continue;
    }

    // Quiet-hours is opt-in (default = interrupt instantly). When on, hold a non-urgent flag to
    // the morning via an Autonome automation; CRITICAL / suspected fraud always interrupts.
    const hold = respectQuiet && inQuietHours(tz) && verdict.severity !== 'critical' && !verdict.suspectedFraud;
    try {
      if (hold) {
        await createAutomation({
          agentHandle: handle, chatId: targetChat, source: 'email',
          instruction: heldInstruction(verdict, email),
          scheduleKind: 'once', nextRunAt: new Date().toISOString(),
          timezone: tz, respectQuietHours: true, dedupeKey: `judge:${email.id}`,
        });
      } else {
        // A suspected-fraud / critical flag must not wait behind a chatty live reply in the send
        // queue — mark it critical so it bypasses pacing and jumps the queue.
        const priority = (verdict.suspectedFraud || verdict.severity === 'critical') ? 'critical' as const : undefined;
        await sendFollowUp(targetChat, message, { record: true, priority });
      }
      // Delivered (or queued for morning): hand the facts to Convo and mark done.
      newContexts.push(toContext(email, verdict));
      seen.add(email.id);
      newest = Math.max(newest, email.internalDate);
      flagged++;
    } catch (err) {
      // Don't mark seen and don't advance past it — the next push/backstop retries this email,
      // so a transport hiccup can't silently swallow a critical flag (at-least-once delivery).
      console.error(`[judge] failed to surface email ${email.id} for ${handle}`, err);
      // A held cursor is invisible from the outside: the run logs "surfaced 0" and looks idle. This
      // is the row that says a judged-important email is still waiting on a retry.
      reportError({
        source: 'judge',
        category: 'surfacing_failure',
        message: `failed to surface email ${email.id}`,
        err,
        handle,
        chatId: targetChat,
        detail: { emailId: email.id, held: hold, severity: verdict.severity, suspectedFraud: verdict.suspectedFraud },
      });
      hadFailure = true;
    }
  }

  // Batch all pref writes into one upsert (fewer round-trips, smaller race window). Advance the
  // discovery cursors ONLY on a clean run; the dedupe ring and the flagged-context list always
  // persist (they record what genuinely got through).
  const updates: Record<string, unknown> = {};
  if (seen.size !== surfaced.length) updates.surfaced_email_ids = [...seen].slice(-SURFACED_RING);
  if (newContexts.length) {
    const prior: PendingContext[] = Array.isArray(prefs.pending_email_contexts) ? (prefs.pending_email_contexts as PendingContext[]) : [];
    updates.pending_email_contexts = [...prior, ...newContexts].slice(-PENDING_CONTEXTS);
    // Durable short-term rows (the tier Convo's context block reads; the prefs list above is
    // the soak-window dual-write). taskId = gmail message id, so the unique index makes this
    // at-least-once loop's re-runs no-ops. Best-effort: a lost row degrades, never blocks.
    for (const ctx of newContexts) {
      await addShortTerm({
        agentHandle: handle, chatId: targetChat, kind: 'email_flag',
        request: ctx.subject, content: ctx.summary, taskId: ctx.emailId, ttlMs: PENDING_EMAIL_TTL_MS,
        meta: {
          from: ctx.from, subject: ctx.subject, severity: ctx.severity, category: ctx.category,
          deadlineDate: ctx.deadlineDate, deadlineLabel: ctx.deadlineLabel, suggestReminder: ctx.suggestReminder,
        },
      }).catch(err => console.error(`[judge] failed to persist short-term email flag ${ctx.emailId}`, err));
    }
  }
  if (!hadFailure) {
    // A fetch gap means a message we were told about couldn't be hydrated (transient). Hold BOTH
    // cursors: the history cursor so the next push re-lists it, AND the watermark — otherwise, if the
    // held history cursor later 404s and discovery drops to the watermark scan, the gap message
    // (which predates the advanced watermark) gets filtered out and lost for good.
    if (newest > watermark && !fetchGap) updates.email_watermark = newest;
    if (newHistoryId && !fetchGap) updates.gmail_watch_history_id = newHistoryId;
  }
  if (Object.keys(updates).length) await setPreferences(handle, updates);
  // Commit the fresh history cursor (captured before the fallback scan, so it covers mail that
  // arrived during the run) ONLY after a fully clean stale-cursor recovery — no send failure, no
  // fetch gap. If the run bailed early or anything was held, we leave the old stale cursor untouched
  // so the next run re-enters the 404→fallback path and re-discovers, instead of the history path
  // skipping past un-surfaced mail.
  if (staleCursor404 && !hadFailure && !fetchGap && reseedHistoryId) {
    await setPreferences(handle, { gmail_watch_history_id: reseedHistoryId });
  }
  const held = hadFailure ? ' (a send failed; cursors held for retry)' : fetchGap ? ' (a fetch gap; cursors held for retry)' : '';
  if (emails.length || fetchGap) console.log(`[judge] ${handle}: judged ${emails.length} email(s), surfaced ${flagged}${held}`);
}

/**
 * Index recently-SENT mail into the search index. The push watch covers INBOX only, so the
 * user's own outbound (the other half of "has X responded" questions) arrives via this sweep.
 */
async function indexRecentSentForHandle(handle: string): Promise<void> {
  if (process.env.EMAIL_INDEX_SENT === 'false') return;
  try {
    const sent = await fetchRecentSent(handle, { newerThanDays: 2, maxResults: 20 });
    if (sent.length) await upsertEmails(handle, sent);
  } catch (err) {
    if (err instanceof GmailReauthRequired) return;
    console.warn(`[judge] sent-mail index sweep failed for ${handle}`, err);
  }
}

/** Backstop sweep: re-runs the Judge for every connected agent to catch dropped push notifications. */
export function startEmailBackstop(sendFollowUp: SendFollowUp): void {
  if (process.env.EMAIL_BACKSTOP_ENABLED === 'false') {
    console.log('[judge] backstop poll disabled (EMAIL_BACKSTOP_ENABLED=false)');
    return;
  }
  console.log(`[judge] backstop poll starting — every ${Math.round(BACKSTOP_INTERVAL_MS / 60000)} min`);
  const tick = async () => {
    try {
      const handles = await listConnectedHandles();
      for (const handle of handles) {
        await judgeNewEmailsForHandle(handle, sendFollowUp, { trigger: 'backstop' }).catch(e => console.error(`[judge] backstop failed for ${handle}`, e));
        await indexRecentSentForHandle(handle);
      }
    } catch (err) {
      console.error('[judge] backstop tick failed', err);
    }
  };
  setTimeout(() => void tick(), 45_000);
  setInterval(() => void tick(), BACKSTOP_INTERVAL_MS);
}

/**
 * The DAILY email pass — Judge as "Reflexion for email". Once each morning, for ACTIVE users only,
 * judge the last 48h of UNREAD mail and surface anything important as ONE digest (silent when nothing
 * matters). Each email is surfaced at most once, ever (digest_surfaced_ids ring) — never re-mentioned.
 * READ mail keeps flowing into the search index continuously via the always-on push path; this pass
 * only decides what's worth telling the user about.
 */
export async function runDailyJudgePass(handle: string, sendFollowUp: SendFollowUp): Promise<void> {
  const memory = await getMemory(handle);
  const prefs = memory?.prefs ?? {};
  if (prefs.email_digest === false) { console.log(`[judge-daily] ${handle}: digest disabled by user`); return; }
  const targetChat = prefs.chat_id as string | undefined;
  if (!targetChat) { console.log(`[judge-daily] no chat_id for ${handle}; skipping`); return; }

  // Active-user gate: skip at zero LLM cost if the user has gone quiet for JUDGE_INACTIVE_DAYS (default
  // 3). Presence-tolerant like Reflexion's isDormant — a scoped window with no user line is inactive;
  // otherwise measure recency from the newest user line (Irises's own outbound is ignored).
  const history = await getConversation(targetChat).catch(() => []);
  const scoped = scopeHistoryToUser(history, handle);
  let lastUserAt = 0;
  for (let i = scoped.length - 1; i >= 0; i--) { if (scoped[i].role === 'user') { lastUserAt = scoped[i].at ?? 0; break; } }
  const hasUserLine = scoped.some(m => m.role === 'user');
  const inactive = lastUserAt === 0 ? !hasUserLine : (Date.now() - lastUserAt > JUDGE_INACTIVE_MS);
  if (inactive) { console.log(`[judge-daily] ${handle}: inactive >${Math.round(JUDGE_INACTIVE_MS / 86_400_000)}d — skipping`); return; }

  const tz = (prefs.agent_tz as string | undefined) || DEFAULT_TZ;
  const ring: string[] = Array.isArray(prefs.digest_surfaced_ids) ? (prefs.digest_surfaced_ids as string[]) : [];
  const seen = new Set(ring);

  let fetched: DealEmail[];
  try {
    // fetchInbox forces `is:unread newer_than:Nd category:primary`. The window is 48h, not 24h, so
    // the retries below are real: a digest whose SEND failed drops its ids from the ring, and a
    // per-email judge failure drops one — both are still inside tomorrow's fetch (and still unread).
    // Nothing gets re-mentioned: the ring (200 ids, far above 2x POLL_MAX) dedupes the overlap.
    const fb = await fetchInbox(handle, { newerThanDays: 2, maxResults: POLL_MAX });
    fetched = fb.emails;
  } catch (err) {
    if (err instanceof GmailReauthRequired) { console.log(`[judge-daily] ${handle} needs Gmail re-auth; skipping`); return; }
    console.error(`[judge-daily] fetch failed for ${handle}`, err);
    return;
  }
  const unread = fetched
    .filter(e => e.labelIds.includes('UNREAD') && !seen.has(e.id))
    .sort((a, b) => a.internalDate - b.internalDate);
  if (!unread.length) return; // nothing new + unread → stay silent

  const [profile, medium, ownFlags, longDoc] = await Promise.all([
    getUserProfile(handle),
    loadMediumBundle(handle),
    listShortTerm(handle, { kinds: ['email_flag'], limit: 8 }),
    getLongDoc(handle),
  ]);
  const memoryData = { profile, memory, medium, short: ownFlags, longDocMd: longDoc?.docMd ?? '' };
  const userCtx = renderUserMemory('judge', memoryData);
  // The synthesis call is the ONE Judge path that gets medium memory. The matrix withholds it from
  // per-email judging as an evidence boundary (an email must not be corroborated by remembered
  // facts); synthesis only consolidates verdicts already decided without it, so the boundary holds
  // while the digest still speaks to the things the user actually cares about.
  const digestCtx = renderUserMemory('judge', memoryData, Date.now(), { includeMedium: true });

  const important: { email: DealEmail; verdict: JudgeVerdict }[] = [];
  for (const email of unread) {
    seen.add(email.id); // judged this run — don't reconsider tomorrow (kept even for "not important")
    try {
      // Verdict only: the per-email surfacing text would be thrown away by the synthesis step below.
      const { verdict } = await judgeEmail(email, handle, { userMemoryBlock: userCtx, timezone: tz, recentHistory: history, chatId: targetChat, digestMode: true });
      if (verdict.important) important.push({ email, verdict });
    } catch (err) {
      seen.delete(email.id); // transient failure — let tomorrow's pass retry this one
      console.error(`[judge-daily] judge failed for ${email.id}`, err);
    }
  }

  if (important.length) {
    // Synthesize the batch into a consolidated, human-like digest via the Judge model.
    // Falls back to a plain-text message on LLM failure — an important digest is never dropped.
    const digestMessage = await synthesizeDigest(important, handle, { userMemoryBlock: digestCtx, timezone: tz })
      ?? fallbackDigest(important, tz);
    try {
      await sendFollowUp(targetChat, digestMessage, { record: true });
      // Persist each surfaced email to short-term (kind email_flag): Convo reads it to field a "remind
      // me" follow-up, and Reflexion's nightly pass folds it into long-term memory — so a surfaced-once
      // email still becomes durable knowledge without ever being re-mentioned.
      for (const { email, verdict } of important) {
        await addShortTerm({
          agentHandle: handle, chatId: targetChat, kind: 'email_flag',
          request: email.subject, content: verdict.summary, taskId: email.id, ttlMs: PENDING_EMAIL_TTL_MS,
          meta: {
            from: email.from, subject: email.subject, severity: verdict.severity, category: verdict.category,
            deadlineDate: verdict.deadlineDate, deadlineLabel: verdict.deadlineLabel, suggestReminder: verdict.suggestReminder,
          },
        }).catch(e => console.error(`[judge-daily] short-term write failed ${email.id}`, e));
      }
    } catch (err) {
      for (const { email } of important) seen.delete(email.id); // send failed — the 48h fetch window re-judges these tomorrow
      console.error(`[judge-daily] digest send failed for ${handle}`, err);
    }
  }
  await setPreferences(handle, { digest_surfaced_ids: [...seen].slice(-DIGEST_RING) });
  console.log(`[judge-daily] ${handle}: judged ${unread.length} unread, surfaced ${important.length}`);
}
