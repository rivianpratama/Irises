// The Reflexion runner — Irises's memory curator. One entry point (runReflexionQueued) that all
// three triggers converge on: the daily local-midnight cron, a Convo delegation (update_memory),
// and a self-scheduled wake. FULLY SILENT: no composer, no Fallfirm, no sendFollowUp, no mouth —
// its only outputs are tier writes and an internal changelog in the diagnostics trace.
//
// Cost discipline (Opus-xhigh): the skip-if-quiet gate makes idle users cost zero; the seed
// prompt preloads everything a typical run needs (1–3 turns of pure writes); hard ceilings on
// steps/tokens/wall-clock; and REFLEXION_ENABLED=false short-circuits everything.

import { callLLM } from '../../llm/callLLM.js';
import { loadContext } from '../loadContext.js';
import { withDeadline } from '../deadline.js';
import { getConversation } from '../../state/conversation.js';
import { getMemory } from '../../db/repositories/memory.js';
import { listShortTerm } from '../../db/repositories/memoryShort.js';
import { listMediumAll } from '../../db/repositories/memoryMedium.js';
import { getLongDoc, listLongRevisions } from '../../db/repositories/memoryLong.js';
import { getReflexionState, markRunComplete, markMigrated } from '../../db/repositories/reflexionState.js';
import { countWakesToday } from '../../db/repositories/automations.js';
import { wrapPrompt } from '../../llm/promptTag.js';
import { DEFAULT_TZ } from '../../pipeline/zonedTime.js';
import { record } from '../../diagnostics/trace.js';
import { reportError } from '../../diagnostics/errorLog.js';
import { REFLEXION_TOOLS, dispatchReflexionTool, type ReflexionRunCtx } from './tools.js';
import { buildReflexionSeed } from './seedBuilder.js';
import { scopeHistoryToUser } from '../../memory/transcript.js';
import type { ReflexionTask } from '../types.js';
import type { LlmMessage, LlmRole } from '../../llm/types.js';
import type { StoredMessage } from '../../db/types.js';

const MAX_STEPS = Number(process.env.REFLEXION_MAX_STEPS) || 12;
const TASK_TIMEOUT_MS = Number(process.env.REFLEXION_TASK_TIMEOUT_MS) || 5 * 60_000;

/** One kill switch for the whole subsystem: the runner branch, the daily seed, and the Convo
 *  delegate tool all check this. */
export function reflexionEnabled(): boolean {
  return process.env.REFLEXION_ENABLED !== 'false';
}

/** Newest INBOUND (user-role) message timestamp in a loaded history window, or 0 if none.
 *  Irises's own assistant/outbound messages are ignored on purpose — see isQuietSinceLastDaily. */
export function lastUserMessageAt(history: StoredMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].at ?? 0;
  }
  return 0;
}

/** The daily skip-if-quiet decision, isolated here so "what counts as added material" lives in
 *  one place and is unit-testable without the LLM/DB. A daily pass has nothing to do when — since
 *  the last completed daily pass — there was NO inbound user message AND no fresh short-term
 *  record (Ops research, MM media analysis, Judge email flag). Irises's OWN proactive outbound
 *  (reminders, progress pings, an unanswered reach-out) is NOT added material: a day where only
 *  Irises spoke stays silent, UNLESS it also produced short-term — a surfaced email or background
 *  research — which the short-term signal catches independently of the chat log. */
export function isQuietSinceLastDaily(opts: {
  history: StoredMessage[];
  lastDailyAt: number;
  freshShortCount: number;
}): boolean {
  return lastUserMessageAt(opts.history) <= opts.lastDailyAt && opts.freshShortCount === 0;
}

/** Dormant = the user has sent Irises NO message within the conversation window (~7 days). Such a
 *  user may still have a connected inbox flagging emails, but they are not interacting with Irises —
 *  a daily curation run would spend Opus on a ghost. This is a HARDER gate than
 *  isQuietSinceLastDaily: it overrides the short-term signal so an inactive-but-email-connected
 *  user stays at zero LLM cost. A user who chatted at all in the window is NOT dormant and still
 *  gets the finer quiet gate (so a real quiet day still captures an overnight email flag). Robust
 *  to missing timestamps — it counts the PRESENCE of an inbound line, never its `at`. Pass the
 *  ALREADY-scoped history (this user's lines). */
export function isDormant(scopedHistory: StoredMessage[]): boolean {
  return !scopedHistory.some(m => m.role === 'user');
}

// Per-handle serialization: daily + delegated + wake runs for one user never interleave — a
// second trigger queues and re-reads fresh state when it starts (back-to-back runs are cheap
// no-ops thanks to the quiet gate). Strictly the OUTER lock: the memory repos' withHandleLock
// is inner and never awaits reflexion, so ordering can't invert. In-process only (single-VM
// deployment, same accepted limitation as memory.ts's write locks).
const runLocks = new Map<string, Promise<unknown>>();

/** Queue a run behind any in-flight run for the same handle. Never rejects. */
export function runReflexionQueued(task: ReflexionTask): Promise<void> {
  const prev = runLocks.get(task.agentHandle) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => runReflexion(task))
    .catch(err => console.error('[reflexion] run failed', err));
  runLocks.set(task.agentHandle, next);
  void next.finally(() => { if (runLocks.get(task.agentHandle) === next) runLocks.delete(task.agentHandle); });
  return next;
}

async function runReflexion(task: ReflexionTask): Promise<void> {
  if (!reflexionEnabled()) return;
  const handle = task.agentHandle;
  const startedAt = Date.now();

  const [state, memory] = await Promise.all([getReflexionState(handle), getMemory(handle)]);
  const tz = (memory?.prefs.agent_tz as string | undefined) || DEFAULT_TZ;
  const legacyPresent = !!(memory && (memory.dossierMd?.trim()
    || (Array.isArray(memory.prefs.directives) && memory.prefs.directives.length)
    || (Array.isArray(memory.prefs.important_notes) && memory.prefs.important_notes.length)));
  const needsMigration = legacyPresent && !state?.migratedAt;
  // The daily skip-if-quiet anchor, hoisted so the seed and the gate share one value.
  const lastDaily = state?.lastDailyAt ?? 0;

  // Skip-if-quiet (daily only, the dominant cost lever): no inbound user message and nothing
  // researched since the last completed daily pass → zero Opus tokens spent. Measuring INBOUND
  // (not any message) is deliberate — a day where only Irises's proactive outbound fired (a
  // reminder, a progress ping the user never answered) is a silent day and must not trigger a
  // full curation run; the genuinely-durable outbound (a surfaced email, background research)
  // registers through the short-term signal instead. A pending migration always runs;
  // delegated/self-wake runs carry an explicit reason, so they always run too.
  if (task.trigger === 'daily' && !needsMigration) {
    const [history, freshShort] = await Promise.all([
      getConversation(task.chatId).catch(() => []),
      listShortTerm(handle, { sinceMs: lastDaily, limit: 1 }),
    ]);
    // Scope to THIS user's rows first: another participant chatting in a shared/mis-bound
    // thread must not count as added material for this user's daily curation.
    const scoped = scopeHistoryToUser(history, handle);
    // Dormant-user cost guard (the strongest lever): a user with ZERO inbound messages in the window
    // is not interacting with Irises — even if a connected inbox is still flagging emails. Skip for
    // zero Opus, deliberately IGNORING the short-term signal a ghost's inbox generates. A user who
    // chatted at all in the window falls through to the finer gate below, so a genuinely-active
    // user's quiet day still captures overnight flags.
    if (isDormant(scoped)) {
      record({ type: 'event', chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:skipped', detail: { reason: 'dormant: no inbound chat in the conversation window; email activity ignored to keep an inactive user at zero LLM cost' } });
      await markRunComplete(handle, 'daily'); // advance the anchor so tomorrow measures from today
      return;
    }
    if (isQuietSinceLastDaily({ history: scoped, lastDailyAt: lastDaily, freshShortCount: freshShort.length })) {
      record({ type: 'event', chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:skipped', detail: { reason: 'no inbound message or research since last daily pass' } });
      await markRunComplete(handle, 'daily'); // advance the anchor so tomorrow measures from today
      return;
    }
  }

  // ── Seed: preload everything a run needs; the pure builder (seedBuilder.ts) turns it into text ──
  // The curator writes under THIS handle, so it may only read THIS user's lines (plus the
  // assistant's) — the builder scopes the window before rendering it. Unscoped, a shared/mis-bound
  // thread would curate another participant's words — their nickname, their style — into this
  // user's tiers.
  const nowMs = Date.now();
  const [history, shortEntries, mediumRows, longDoc, longRevs, wakesUsed] = await Promise.all([
    getConversation(task.chatId).catch(() => []),
    listShortTerm(handle, { limit: 40 }),
    listMediumAll(handle),
    getLongDoc(handle),
    listLongRevisions(handle, 10).catch(() => []),
    countWakesToday(handle, tz),
  ]);

  const seedParts = buildReflexionSeed({
    task, tz, nowMs,
    lastDailyAt: state?.lastDailyAt ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    needsMigration,
    selfPromptMd: state?.selfPromptMd ?? '',
    selfPromptRevs: state?.selfPromptRevs ?? [],
    mediumRows, longDoc, longRevs, shortEntries, history, wakesUsed,
  });

  const messages: LlmMessage[] = [{ role: 'user', content: wrapPrompt(seedParts.join('\n\n')) }];
  const ctx: ReflexionRunCtx = { task, tz, writes: 0, wakes: 0 };
  const system = loadContext('reflexion');
  // A Convo-delegated update_memory run (a user explicitly asked Irises to remember something on the
  // live turn) uses the lighter reflexion_delegated model tier; the silent daily/self-wake passes stay
  // on the full reflexion tier. Same persona + tools + guards — only the model/effort config differs.
  const llmRole: LlmRole = task.trigger === 'delegated' ? 'reflexion_delegated' : 'reflexion';

  // Delegated runs get a delegation-typed event too (same pattern as the Ops/MM runners), so the
  // dashboard draws the Convo → Reflexion edge; scheduled runs enter via reflexion:start below.
  if (task.trigger === 'delegated') {
    record({ type: 'delegation', chatId: task.chatId, handle, taskId: task.id, label: 'delegate:memory_update', detail: { request: task.request } });
  }
  record({ type: 'event', chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:start', detail: { trigger: task.trigger, focus: task.focus, needsMigration } });

  try {
    await withDeadline((async () => {
      let changelog = '';
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await callLLM({
          role: llmRole,
          system,
          tools: REFLEXION_TOOLS, // NATIVE tools — a real multi-turn loop, plain-text finish
          messages,
          trace: { chatId: task.chatId, handle, taskId: task.id, label: `reflexion:step${step}` },
        });

        if (res.toolCalls.length === 0) {
          changelog = (res.text ?? '').trim();
          break;
        }

        messages.push({ role: 'assistant', content: res.text || '(curating)' });
        const lines: string[] = [];
        for (const call of res.toolCalls) {
          const result = await dispatchReflexionTool(call.name, call.input ?? {}, ctx);
          lines.push(`TOOL ${call.name} RESULT:\n${result}`);
        }
        messages.push({
          role: 'user',
          content: `${lines.join('\n\n')}\n\nContinue with more tool calls, or finish with the one-paragraph changelog and no tool calls.`,
        });
      }

      if (!changelog) {
        // Ran out of steps mid-curation — ask for the changelog with tools withheld. Partials are
        // safe: every write was append/supersede, and the next pass reconciles the rest.
        const final = await callLLM({
          role: llmRole,
          system,
          messages: [...messages, { role: 'user', content: 'Step budget exhausted. Write the one-paragraph internal changelog of what you changed so far and what remains for the next pass.' }],
          trace: { chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:final' },
        });
        changelog = (final.text ?? '').trim();
      }

      record({
        type: 'event', chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:done',
        detail: { trigger: task.trigger, writes: ctx.writes, wakes: ctx.wakes, ms: Date.now() - startedAt, changelog: changelog.slice(0, 1500) },
      });
    })(), TASK_TIMEOUT_MS, `reflexion ${task.id}`);
  } catch (err) {
    // A timeout or provider failure never propagates: every completed write is already durable
    // and consistent (append/supersede only), and the next daily pass reconciles the remainder.
    console.error(`[reflexion] run aborted for ${handle} (${task.trigger})`, err);
    record({ type: 'event', chatId: task.chatId, handle, taskId: task.id, label: 'reflexion:aborted', detail: { trigger: task.trigger, writes: ctx.writes, error: String(err).slice(0, 300) } });
    // Reflexion is fully silent, so an aborted pass has no user-visible symptom at all: memory just
    // quietly stops accruing. The durable row is the only place a run of these becomes a pattern
    // (an Opus tier consistently overrunning TASK_TIMEOUT_MS reads as "memory works fine").
    reportError({
      source: 'reflexion',
      category: 'timeout',
      err,
      chatId: task.chatId,
      handle,
      taskId: task.id,
      detail: { trigger: task.trigger, writes: ctx.writes, ms: Date.now() - startedAt, timeoutMs: TASK_TIMEOUT_MS },
      // trace:false — the reflexion:aborted event above is already this run's trace entry, and a
      // partial pass leaves a consistent store, so it deliberately stays off the error badge.
      trace: false,
    });
  }

  await markRunComplete(handle, task.trigger).catch(err => console.error('[reflexion] markRunComplete failed', err));
  // The migration marker gates on ≥1 ACTUAL tier write — an empty or aborted-before-writing
  // migration run must not mark done (the next pass retries it).
  if (needsMigration && ctx.writes > 0) {
    await markMigrated(handle).catch(err => console.error('[reflexion] markMigrated failed', err));
  }
}
