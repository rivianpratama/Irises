// Durable per-agent memory: a living markdown dossier + structured prefs. Assembled
// into the Convo agent's prompt each turn, and refreshed asynchronously after replies.
// (Convo controls Ops, so the dossier only needs to live in Convo; Convo passes
// relevant slices to Ops via meta-prompts.)
import { callLLM } from '../llm/callLLM.js';
import { getMemory, saveDossier, getForgetEpoch } from '../db/repositories/memory.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { listShortTerm, SHORT_TTL_MS, type ShortTermEntry } from '../db/repositories/memoryShort.js';
import { getLongDoc, saveLongDoc } from '../db/repositories/memoryLong.js';
import { loadMediumBundle } from './mediumTerm.js';
import { PENDING_EMAIL_TTL_MS } from './shortTerm.js';
import { renderUserMemoryWithHot, splitSections } from './wrappers.js';
import { buildTurnRelevance, memoryRelevanceEnabled, type TurnRelevance } from './relevance.js';
import { scopeHistoryToUser } from './transcript.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { StoredMessage, UserProfile } from '../db/types.js';

// stripScopeSections now lives in userContext.ts (so the shared renderer can reuse it without a
// circular import). Re-exported here to keep the historical import path stable. Same for the
// short-tier TTLs, which moved to shortTerm.ts with their renderers.
export { stripScopeSections } from './userContext.js';
export { RECENT_RESEARCH_TTL_MS, RECENT_RESEARCH_MAX_CHARS, PENDING_EMAIL_TTL_MS } from './shortTerm.js';

const THROTTLE_MS = 2 * 60 * 1000; // refresh a dossier at most this often
const lastUpdate = new Map<string, number>();
// The rewrite is a FULL-document merge, so the cap has to fit the whole ~400-word dossier plus
// whatever is being merged in — a cut-off reply is a truncated document, not a shorter one
// (see dossierUpdateUsable).
const DOSSIER_MAX_TOKENS = 900;

// How long a "Irises asked a steering question after a thin look" marker stays live. The agent's
// reply within this window is treated as the answer to that question (Convo re-delegates a refined
// second look). Exported so the Convo delegate path computes the same freshness/attempt bump.
// Stays a prefs marker (not a memory tier): it is latest-only control flow with clear-on-condition
// semantics, not memory.
export const PENDING_CLARIFICATION_TTL_MS = 30 * 60 * 1000;

interface RecentResearch { request?: string; kind?: string; summary?: string; at?: number }
interface PendingClarificationCtx { request?: string; kind?: string; attempt?: number; at?: number; missingFields?: string[] }
interface PendingEmailContext {
  emailId?: string; from?: string; subject?: string; summary?: string; severity?: string;
  category?: string; deadlineDate?: string | null; deadlineLabel?: string | null;
  suggestReminder?: boolean; surfacedAt?: number;
}

/**
 * The coarse day → week → month → year ladder, with no "ago" on it. THE one place this arithmetic
 * lives: formatAgo below wears it as "~3 weeks ago", and the climate eval's tenure label wears the
 * same string as "you have known this person: ~3 weeks" (climateDrift.ts). They were two copies and
 * they carried the same bug — `Math.floor(days / 365)` reads 0 for days 360-364, which the month
 * branch has already stopped covering, so a year-old relationship rendered "~0 years". The years
 * branch is only ever reached past 360 days, so its smallest honest answer is one.
 *
 * `days` is whole days elapsed, >= 0. Pure.
 */
export function formatDaySpan(days: number): string {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  const wk = Math.floor(days / 7);
  if (wk < 5) return `~${wk} week${wk === 1 ? '' : 's'}`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `~${mo} month${mo === 1 ? '' : 's'}`;
  const yr = Math.max(1, Math.floor(days / 365));
  return `~${yr} year${yr === 1 ? '' : 's'}`;
}

/** Coarse "how long ago" from an epoch-seconds timestamp, for relationship warmth (not facts). */
function formatAgo(epochSeconds: number | undefined): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  const sec = Math.floor(Date.now() / 1000) - epochSeconds;
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  return `${formatDaySpan(day)} ago`;
}

/**
 * Convo-only: how long you've known them (tenure) and roughly when you last saw them — so the
 * front line can treat a long-time contact like a regular and welcome a brand-new one lightly.
 * NOT injected into the other agents. "last seen" tracks the last time we saved something about
 * them, so keep it soft context, never a hard fact.
 */
function renderTenure(profile: UserProfile | null): string {
  if (!profile) return '';
  const first = formatAgo(profile.firstSeen);
  if (!first) return '';
  // Only mention "last seen" when it's meaningfully more recent than first contact (> ~1 day).
  const last = formatAgo(profile.lastSeen);
  const showLast = last && profile.lastSeen - profile.firstSeen > 86400;
  const line = showLast ? `First seen ${first}; last seen ${last}.` : `First seen ${first}.`;
  return `## How long you've known them\n${line}\nThis is soft context for warmth only — a long-time contact is a regular, a brand-new one gets a lighter touch. Don't recite these dates back to them.`;
}

/**
 * Assemble the full context block injected into the Convo system prompt: the Convo-only PLAIN
 * sections (tenure, pending-clarification — system-derived operational
 * data, not memory tiers) followed by the WRAPPED memory tiers (wrappers.ts: preamble → short →
 * medium → flexible LAST for recency). The wrapped part carries its own data tags + handling
 * prose, so the caller injects this string bare — no dataTag('user_context') around it.
 */
export async function buildContextBlock(handle: string, currentTurnText?: string): Promise<string> {
  return (await buildContextBlockWithHot(handle, currentTurnText)).block;
}

/** The context block, plus which short-tier look rendered HOT inside it (see ShortBlockRender in
 *  wrappers.ts) and this turn's relevance router (memory/relevance.ts). Identical bytes to
 *  buildContextBlock, which is a one-line wrapper over this.
 *
 *  The hot look is the one held thing the memory stack has already proved touches this turn, so the
 *  turn-focus block names it as evidence (agents/convo/turnFocus.ts) — this is the last leg of that
 *  verdict's trip back out to convo/client.ts. `null` whenever no look rendered in full.
 *
 *  `turn` is built HERE and nowhere else, because this is the only place that holds every tier at
 *  once: the loaders' own results, before anything is rendered. It rides back out because the
 *  caller needs the same verdict for the turn-focus block and the turn receipt, and rebuilding it
 *  there would mean re-reading every store. `null` when the feature flag is off. */
export async function buildContextBlockWithHot(
  handle: string,
  currentTurnText?: string,
): Promise<{ block: string; hotLook: ShortTermEntry | null; turn: TurnRelevance | null }> {
  const [memory, profile, shortEntries, medium, longDoc] = await Promise.all([
    getMemory(handle),
    getUserProfile(handle),
    listShortTerm(handle, { limit: 30 }),
    loadMediumBundle(handle),
    getLongDoc(handle),
  ]);

  const prefs = memory?.prefs ?? {};

  const parts: string[] = [];

  // Convo-only: how long you've known them (tenure/recency), for relationship warmth.
  const tenure = renderTenure(profile);
  if (tenure) parts.push(tenure);

  // Short-tier payload: memory_short rows are the source; the legacy prefs stashes
  // (recent_research / pending_email_contexts) map into synthetic entries so the soak-window
  // fallback flows through the same wrapped renderer. Per-kind: fall back only when the tier
  // has nothing of that kind (dual-writing keeps them equivalent otherwise).
  const researchEntries = shortEntries.filter(e => e.kind === 'ops_research' || e.kind === 'media_analysis');
  const rr = prefs.recent_research as RecentResearch | undefined;
  const legacyResearch: ShortTermEntry | null =
    rr?.summary && typeof rr.at === 'number'
      ? {
          id: 'legacy:recent_research', agentHandle: handle, kind: 'ops_research',
          request: rr.request, content: String(rr.summary), meta: {}, createdAt: rr.at, expiresAt: rr.at + SHORT_TTL_MS,
        }
      : null;

  // Pending clarification: you recently asked the agent a steering question because a look came
  // back thin (they never heard it was thin). Their next message is almost certainly them
  // narrowing that ask — so re-run the look, don't answer from memory or treat it as a new topic.
  const pc = prefs.pending_clarification as PendingClarificationCtx | undefined;
  if (pc?.request && typeof pc.at === 'number' && Date.now() - pc.at <= PENDING_CLARIFICATION_TTL_MS) {
    const asked = pc.missingFields?.length ? `\nYou specifically asked them for: ${pc.missingFields.join('; ')}.` : '';
    parts.push(`## You just asked them to narrow something down (their next reply likely answers it)\nA recent look at "${pc.request}" came back thin, so you asked them a quick steering question instead of telling them.${asked}\nWhen they reply, treat it as them narrowing THAT ask. delegate_to_ops again with the original ask plus what they just clarified, combined. Do NOT answer it from memory, and do NOT treat it as a brand-new topic. If they clearly changed the subject instead, handle the new thing normally.`);
  }

  // Judge-flagged emails: same tier-first / legacy-fallback shape as research above.
  const emailEntries = shortEntries.filter(e => e.kind === 'email_flag');
  const legacyFlags: ShortTermEntry[] = emailEntries.length
    ? []
    : (Array.isArray(prefs.pending_email_contexts) ? (prefs.pending_email_contexts as PendingEmailContext[]) : [])
        .filter(pe => pe?.summary && typeof pe.surfacedAt === 'number')
        .map((pe, i) => ({
          id: `legacy:email_flag:${pe.emailId ?? i}`, agentHandle: handle, kind: 'email_flag' as const,
          request: pe.subject, content: String(pe.summary), createdAt: pe.surfacedAt!, expiresAt: pe.surfacedAt! + PENDING_EMAIL_TTL_MS,
          meta: { from: pe.from, subject: pe.subject, deadlineDate: pe.deadlineDate, deadlineLabel: pe.deadlineLabel },
        }))
        .reverse(); // legacy list is oldest→newest; the wrapper expects newest first

  const shortForWrapper = [
    ...(researchEntries.length ? researchEntries : legacyResearch ? [legacyResearch] : []),
    ...(emailEntries.length ? emailEntries : legacyFlags),
  ].sort((a, b) => b.createdAt - a.createdAt);

  const nowMs = Date.now();
  const longDocMd = longDoc?.docMd ?? '';

  // ONE relevance verdict for the turn, over exactly what the loaders came back with — the router
  // is pure, so it can only see what it is handed. Handed the same things the renderers are: the
  // short tier filtered for expiry the way the renderer filters it (a legacy synthetic entry can
  // arrive already expired), and the long doc split at the granularity the sanitizer uses. So a
  // named hit is something the model can see — a look as its full body or as its settled digest
  // line, a long section as its own text.
  //
  // Built from `currentTurnText`, which on the Convo path is `userMessage` — deliberately, and
  // ahead of transcription/attachments (see convo/client.ts): these reads run inside a Promise.all
  // that has to start before the media work, and moving them after it would cost a turn's latency
  // to buy nothing. A caption-less media turn therefore reaches the router with no text at all,
  // which is exactly why every gate reads `whenEmpty: 'touch'` and fails OPEN.
  const turn = memoryRelevanceEnabled()
    ? buildTurnRelevance(currentTurnText, {
        short: shortForWrapper.filter(e => e.expiresAt > nowMs),
        medium,
        longSections: splitSections(longDocMd || (memory?.dossierMd ?? '')),
      })
    : null;

  // The wrapped memory tiers LAST: preamble → short → medium → flexible (identity/addressing +
  // long doc + directives) in the recency slot; the persona's hard rules stay anchored at the
  // top of the system prompt and outrank all of it.
  const wrapped = renderUserMemoryWithHot('convo', {
    profile, memory, medium, short: shortForWrapper, longDocMd,
  }, nowMs, { audience: isGroupHandle(handle) ? 'group' : 'individual', currentTurnText, turn });
  parts.push(wrapped.text);

  return { block: parts.join('\n\n'), hotLook: wrapped.hotEntry, turn };
}

/** The dossier updater's harvest contract — exported so tests can pin the two-family
 *  capture (operational + personal color), the canonical section order, and the attribution
 *  clause that keeps ANOTHER participant's "call me X" out of this user's dossier when a
 *  thread has ever carried more than one person. */
export const DOSSIER_SYSTEM_PROMPT = `You maintain a concise markdown dossier of durable facts ABOUT THE USER, for an assistant to reference. Capture ONLY long-lived facts, in two families:

OPERATIONAL: name/how they like to be addressed (e.g. a nickname or "call me Chief"), where they are and their timezone, communication style (e.g. casual/lowercase, brief), what they do for work and who they do it with or for, the tools and services they live in, recurring working habits.

PERSONAL COLOR (what lets the assistant sound like it knows them): active projects and side ventures with the NAMES they use for them (e.g. 'fixing up a lake cabin — calls it "the shack"'); current arcs and goals with a rough as-of date (e.g. "training for a marathon, since june"); standing personal rules recorded as rules, phrased their way (e.g. "no meetings sunday mornings, ever"); recurring jokes or themes; people and pets they mention repeatedly; the vocabulary they use for their own things — their words, never your paraphrase. When an arc or project moves on, update its line in place rather than stacking history.

Keep the dossier under these headings, in this order, merging into them (create a heading only when it has content): "## Who they are", "## How they work", "## How to text them", "## Their world", "## Running jokes". Order matters — later sections are dropped first when space runs out.

NEVER record anything about the ASSISTANT's scope, capabilities, or what it can/can't do. Specifically, do NOT write "Scope", "Capabilities", "Out of scope", "in scope", "not my lane", "requires a connected account", or any list of things the assistant does or refuses — the assistant's abilities are defined by its own instructions, NOT learned from conversations, and recording them here corrupts its behavior. Also skip ephemeral chatter and one-off questions. Transient TASK detail (a one-off lookup, a figure from a single request, a date on someone else's calendar) lives elsewhere — but a personal or professional project of THEIRS (something they're building, a side venture, an exam they're grinding for) is NOT transient detail; it belongs in "## Their world". For sensitive ground (health, faith, family, money beyond the professional), keep only what they volunteered, phrased as they phrased it, and never infer or record the reason behind a habit or rule.

Merge new facts into the existing dossier, dedupe, drop anything contradicted, and DELETE any pre-existing scope/capability/out-of-scope section you find. Keep it under ~400 words. Return ONLY the updated markdown, no preamble.

ATTRIBUTION: the transcript contains ONLY this user's own messages (labeled "user (<their handle>):") plus the assistant's replies. The assistant may be addressing or quoting OTHER people — record ONLY facts, names, nicknames, and style signals the user stated in their own "user (…)" lines, never something harvested from an assistant line alone.`;

/**
 * Render the dossier updater's transcript from an ALREADY-SCOPED window: the user's own
 * lines labeled with their handle, assistant lines labeled plainly. Exported for tests —
 * this labeling (plus the ATTRIBUTION clause above) is what keeps another participant's
 * "call me X" out of this user's dossier.
 */
export function buildDossierTranscript(handle: string, recent: StoredMessage[]): string {
  return recent
    .slice(-12)
    .map(m => (m.role === 'user' ? `user (${m.handle ?? handle}): ${m.content}` : `assistant: ${m.content}`))
    .join('\n');
}

/**
 * May this rewrite be PERSISTED? The updater returns the whole merged document, so a truncated
 * reply is not a shorter dossier — it is a document that stops mid-merge, and the canonical order
 * ("later sections are dropped first") means the tail — ## Their world, ## Running jokes — is
 * simply gone. Saving it silently DELETES durable memory, and the next pass then merges into the
 * mutilated version, so the loss compounds. Stale beats corrupted: reject and let the next pass
 * (≥THROTTLE_MS out) redo the merge from the intact doc. Pure — pinned by dossier.test.ts.
 */
export function dossierUpdateUsable(res: { truncated: boolean }): boolean {
  return !res.truncated;
}

/**
 * Persist a completed merge: the legacy dossier first, then the versioned long-tier mirror.
 * Split out of updateDossier so the two race guards can be tested without an LLM call.
 *
 * `baseline` is the state this merge STARTED from — the forget epoch and the doc it merged
 * into. Both guards are "stale beats clobbered", the same doctrine as dossierUpdateUsable:
 *   • epoch moved  → a /forget landed mid-merge; writing would resurrect what they wiped.
 *   • long-doc version conflict → someone else wrote while we were saving. If their content
 *     differs from our baseline, THEY have something we merged from a stale copy — abort and
 *     let the next pass redo the merge from their doc. Only pure version drift (identical
 *     content at a newer version) is safe to retry, and that's the one case that retries.
 * `deps` is the DI seam for tests (no module mocks in this repo).
 */
export async function persistDossierMerge(
  handle: string,
  updated: string,
  baseline: { epoch: number; dossierMd: string },
  deps: {
    saveLong?: typeof saveLongDoc;
    getLong?: typeof getLongDoc;
  } = {},
): Promise<{ dossierSaved: boolean; longSaved: boolean }> {
  const saveLong = deps.saveLong ?? saveLongDoc;
  const getLong = deps.getLong ?? getLongDoc;

  const dossierSaved = await saveDossier(handle, updated, { ifForgetEpoch: baseline.epoch });
  if (!dossierSaved) return { dossierSaved: false, longSaved: false };
  console.log(`[memory] dossier updated for ${handle} (${updated.length} chars)`);

  // Stage-1 dual-write: mirror the merged doc into the versioned long tier so it accrues
  // a warm, revision-tracked history. Reads stay on dossier_md until then; a failure here is
  // logged, never user-facing.
  try {
    const cur = await getLong(handle);
    let version = await saveLong(handle, updated, cur?.version ?? 0, 'dossier_llm');
    if (version == null) {
      if (getForgetEpoch(handle) !== baseline.epoch) {
        console.warn('[memory] long-doc save aborted — /forget landed mid-merge');
        return { dossierSaved, longSaved: false };
      }
      const cur2 = await getLong(handle);
      if ((cur2?.docMd ?? '').trim() !== baseline.dossierMd.trim()) {
        // The winner wrote DIFFERENT content. The old code retried at the fresh version and
        // clobbered it with a merge that never saw it (the /forget-empty-doc bug).
        console.warn('[memory] long-doc save aborted — another writer landed different content mid-merge');
        return { dossierSaved, longSaved: false };
      }
      version = await saveLong(handle, updated, cur2?.version ?? 0, 'dossier_llm');
    }
    return { dossierSaved, longSaved: version != null };
  } catch (err) {
    console.error('[memory] long-doc dual-write failed (legacy dossier already saved)', err);
    return { dossierSaved, longSaved: false };
  }
}

/**
 * Refresh the durable dossier from recent conversation. Async + throttled; never
 * blocks a turn. A cheap Haiku pass merges new durable facts into the existing doc.
 */
export async function updateDossier(handle: string, recent: StoredMessage[]): Promise<void> {
  const now = Date.now();
  if (now - (lastUpdate.get(handle) ?? 0) < THROTTLE_MS) return;
  lastUpdate.set(handle, now);

  try {
    // Scope the window to THIS user before anything renders: in a thread that ever carried
    // another participant, an unfiltered transcript would harvest their words (nickname,
    // style) into this user's dossier. No user lines left → nothing to learn, skip the pass.
    const scoped = scopeHistoryToUser(recent, handle);
    if (!scoped.some(m => m.role === 'user')) return;
    const memory = await getMemory(handle);
    // The fence for a /forget that lands while the LLM below is thinking (see getForgetEpoch):
    // read alongside the doc this merge is about to merge INTO, so the pair is one baseline.
    const epoch0 = getForgetEpoch(handle);
    const transcript = buildDossierTranscript(handle, scoped);
    if (!transcript.trim()) return;

    const res = await callLLM({
      role: 'classify',
      maxTokens: DOSSIER_MAX_TOKENS,
      system: DOSSIER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `EXISTING DOSSIER:\n${memory?.dossierMd || '(empty)'}\n\nRECENT CONVERSATION:\n${transcript}\n\nReturn the updated dossier.`,
      }],
      trace: { handle, label: 'dossier_update' },
    });

    const updated = (res.text ?? '').trim();
    if (!dossierUpdateUsable(res)) {
      // Guard BEFORE both writers (legacy dossier_md + the versioned long tier): a half-merged doc
      // must not become the base revision either. The ERROR event carries the miss into
      // diagnostic_turns so the dashboard shows WHY memory stopped growing for this user.
      console.warn(`[memory] dossier rewrite truncated (stop=${res.stopReason}) — NOT persisting`);
      record({
        type: 'event',
        label: 'memory:dossier_truncated',
        handle,
        response: 'ERROR: dossier rewrite truncated — persist skipped (durable memory protected)',
        detail: { stopReason: res.stopReason, chars: updated.length, maxTokens: DOSSIER_MAX_TOKENS },
      });
      reportError({
        source: 'memory',
        category: 'truncation',
        severity: 'warn',
        message: 'dossier rewrite truncated — persist skipped (durable memory protected)',
        handle,
        detail: { stopReason: res.stopReason, chars: updated.length, maxTokens: DOSSIER_MAX_TOKENS },
        trace: false,   // the ERROR event above already counts against this turn
      });
      return;
    }
    if (updated && updated !== (memory?.dossierMd ?? '').trim()) {
      await persistDossierMerge(handle, updated, { epoch: epoch0, dossierMd: memory?.dossierMd ?? '' });
    }
  } catch (err) {
    console.error('[memory] updateDossier failed', err);
  }
}
