// Short-term (24h) tier renderers — how memory_short rows become prompt sections.
// The recent-research and flagged-emails blocks are ported VERBATIM from the legacy
// prefs-based blocks in dossier.ts so the prompt wording doesn't drift mid-transition
// (renderer snapshot tests hold the parity). The today-digest section is new: it is the
// "never sounds like she forgot this morning" goal, one settled-ground line per look.

import type { ShortTermEntry } from '../db/repositories/memoryShort.js';

// How long a stashed Ops/MM result stays usable for follow-ups before Convo should
// re-delegate. Moved here from dossier.ts (which re-exports for path stability).
export const RECENT_RESEARCH_TTL_MS = 45 * 60 * 1000;
export const RECENT_RESEARCH_MAX_CHARS = 600;

// How long a Judge-flagged email stays in Convo's context so it can field the follow-up
// ("yes, remind me") with the real facts (deadline/subject), not the chat thread. 12h so a
// quiet-hours flag held overnight and voiced at ~8am still has context when they reply.
export const PENDING_EMAIL_TTL_MS = 12 * 60 * 60 * 1000;
export const PENDING_EMAIL_SHOW = 3; // render at most the few most-recent flagged emails

const DIGEST_SHOW = 6;
// One-line digest length for an already-delivered look. Exported so the LIVE renderer
// (wrappers.ts renderShortBlock) uses the SAME cap — one source of truth for "compressed
// to a line, too short to re-recite verbatim".
export const DIGEST_LINE_CHARS = 150;

/**
 * The freshest research/media answer, rendered while still hot (45 min) so Convo answers
 * same-topic follow-ups directly instead of re-delegating. Wording is the legacy block:
 * framed as answer-what-they-ASK, never "re-deliver" (charter §7.8 settled ground).
 */
export function renderRecentResearch(latest: ShortTermEntry | null, nowMs: number = Date.now()): string {
  if (!latest?.content || nowMs - latest.createdAt > RECENT_RESEARCH_TTL_MS) return '';
  const summary = latest.content.slice(0, RECENT_RESEARCH_MAX_CHARS);
  return `## Recent research (you already delivered the answer from this — it's on their screen)\nthey asked: "${latest.request ?? ''}"\n${summary}\nUse this ONLY to answer a NEW question they actually ask about it. Never re-deliver or re-summarize what you already told them — that part is settled ground.`;
}

/**
 * NEW: same-day digest of everything else Irises already did (excluding the entry the
 * recent-research block just rendered, and email flags, which get their own section).
 * One line per look — enough to stay coherent about the day without re-delivering any of it.
 */
export function renderTodayDigest(
  entries: ShortTermEntry[],
  opts: { excludeId?: string } = {},
  nowMs: number = Date.now(),
): string {
  const digestible = entries
    .filter(e => e.kind === 'ops_research' || e.kind === 'media_analysis')
    .filter(e => e.id !== opts.excludeId)
    .filter(e => e.expiresAt > nowMs)
    .slice(0, DIGEST_SHOW);
  if (!digestible.length) return '';
  const label = (k: ShortTermEntry['kind']) => (k === 'media_analysis' ? 'file' : 'research');
  const lines = digestible.map(e => {
    const asked = e.request ? `they asked "${e.request}" → ` : '';
    return `- [${label(e.kind)}] ${asked}${e.content.slice(0, DIGEST_LINE_CHARS)}`;
  });
  return `## Earlier today (already delivered — settled ground, never re-deliver)\n${lines.join('\n')}\nThese are things you already looked up and told them today. Use them so you never sound like you forgot the morning; answer NEW questions from them freely, but never re-state what's already on their screen.`;
}

/**
 * Emails the Judge recently flagged, unprompted. This is the FACT channel for the
 * follow-up (e.g. "yes, remind me 2 days before") — the deadline/subject come from here,
 * not the chat thread. Wording is the legacy block, reading meta fields off the rows.
 */
export function renderFlaggedEmails(entries: ShortTermEntry[], nowMs: number = Date.now()): string {
  const flagged = entries
    .filter(e => e.kind === 'email_flag' && e.content && nowMs - e.createdAt <= PENDING_EMAIL_TTL_MS)
    .slice(0, PENDING_EMAIL_SHOW); // listShortTerm returns newest first — same set/order as the legacy slice(-N).reverse()
  if (!flagged.length) return '';
  const items = flagged
    .map(e => {
      const meta = e.meta as { from?: string; subject?: string; deadlineDate?: string | null; deadlineLabel?: string | null };
      const due = meta.deadlineDate ? ` — deadline: ${meta.deadlineLabel ? `${meta.deadlineLabel} ` : ''}${meta.deadlineDate}` : '';
      return `- from ${meta.from ?? '(unknown)'}, "${meta.subject ?? ''}": ${e.content}${due}`;
    })
    .join('\n');
  return `## Emails you just flagged to them (use these facts for the follow-up, not the chat)\n${items}\nif they want a reminder, set it with schedule_automation using the matching deadline/subject.`;
}
