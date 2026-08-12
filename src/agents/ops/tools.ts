// Ops agent tool definitions + dispatcher. Each handler returns a compact string
// the Opus model reads back. Gmail tools that hit a missing/expired token throw
// GmailReauthRequired, which the runTask loop converts into a needs_auth result.
import type { LlmToolDef } from '../../llm/types.js';
import type { OpsTask, TaskKind } from '../types.js';
import {
  searchEmails, fetchMessageById, fetchThread, getGmailDocs,
  type EmailSearchSpec, type EmailSearchResult, type DealEmail,
} from '../../services/gmail.js';
import { searchEmailIndex, emailIndexStats, type IndexedEmail } from '../../db/repositories/emails.js';
import { getMemory } from '../../db/repositories/memory.js';
import { DEFAULT_TZ, dateTimeInZone } from '../../pipeline/zonedTime.js';
import { searchMessages } from '../../db/repositories/conversations.js';
import { readEmailAttachment, readChatAttachment } from '../../services/attachments.js';
import type { IncomingMedia, ExtractedMedia } from '../../webhook/types.js';
import { draftText } from '../../services/drafting.js';
import { GmailReauthRequired } from '../../oauth/google.js';
import { createAutomation, deriveDedupeKey, listAutomations, listFailedAutomations } from '../../db/repositories/automations.js';
import { describeDateVsToday } from '../../pipeline/dateAge.js';
import { isValidCron } from '../../pipeline/cron.js';
import { reportError } from '../../diagnostics/errorLog.js';
import type { Automation } from '../../db/types.js';

export const ALL_OPS_TOOLS: Record<string, LlmToolDef> = {
  read_url: {
    name: 'read_url',
    description: 'Fetch a web page by URL and return its readable text (HTML tags stripped, capped). Use this to read a specific page the user linked, or a page a web search surfaced, when you need the actual content rather than a snippet. Returns an error line if the page can\'t be fetched.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The full URL to fetch (http/https).' } }, required: ['url'] },
  },
  gmail_docs: {
    name: 'gmail_docs',
    description: 'Read the Gmail research reference: full search-operator syntax (from:, subject:, OR, has:attachment, after:/before:, filename:), what each Gmail tool returns, and worked recipes for status checks, response tracking, timeline recaps, and in-body terms. Call this FIRST when unsure how to phrase a search. Omit "section" for everything, or pass a heading ("Tools", "Search Operators", "Recipes", "Limits").',
    inputSchema: { type: 'object', properties: { section: { type: 'string', description: 'Optional section heading to return just that slice.' } } },
  },
  search_email: {
    name: 'search_email',
    description: [
      "Search the user's own Gmail (live). ALL filters AND together — put ALTERNATIVE phrasings in `queries` (up to 5 raw Gmail formulations, run in parallel, results merged and labeled per variant).",
      "Every result echoes the exact queries run with per-query hit counts, so read that header to see what actually executed. On zero hits the tool auto-broadens (widens dates, loosens terms, includes spam/trash) and reports the trail — a 0 after that means those shapes truly found nothing, not that Gmail wasn't asked.",
      "Dates: pass after/before as YYYY-MM-DD (they compile timezone-correctly — NEVER hand-write after:/before: operators), or newer_than_days (0 = all time). With no date signal a default 365d window applies and is reported.",
      "Pagination: when the result says more results exist, keep calling with page_token until it says otherwise BEFORE reporting completion or absence.",
      "Raw Gmail syntax stays available in query/queries (from:, to:, subject:, \"exact phrase\", OR, -exclude, has:attachment, filename:; see gmail_docs). Results are newest-first with id, thread id, a body preview (read_email for the rest), and attachment ids (open with read_attachment).",
      "Sibling: search_inbox_local matches SUBSTRINGS over the synced local mailbox — better for partial words, fragments, and misspellings.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Raw Gmail search clause (ANDed with the other filters).' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Up to 5 ALTERNATIVE raw formulations, run in parallel and merged. Use for different keyword guesses.' },
        from: { type: 'string', description: 'Sender (name fragment, address, or domain).' },
        to: { type: 'string', description: 'Recipient.' },
        subject: { type: 'string', description: 'Subject-line term(s).' },
        phrase: { type: 'string', description: 'Exact phrase that must appear.' },
        terms: { type: 'array', items: { type: 'string' }, description: 'Body keywords — each must appear (AND).' },
        filename: { type: 'string', description: 'Attachment name or extension (e.g. pdf, invoice.pdf).' },
        has_attachment: { type: 'boolean' },
        after: { type: 'string', description: 'Only mail on/after this date, YYYY-MM-DD (user timezone — compiled correctly for you).' },
        before: { type: 'string', description: 'Only mail before this date, YYYY-MM-DD.' },
        newer_than_days: { type: 'number', description: 'Relative window in days. 0 = ALL TIME. Default 365 when no date given.' },
        include_spam_trash: { type: 'boolean', description: 'Also search spam/trash (excluded by default).' },
        max_results: { type: 'number', description: 'Matches per page (default 20, max 50).' },
        page_token: { type: 'string', description: 'Continue a previous search from where it left off.' },
      },
    },
  },
  search_inbox_local: {
    name: 'search_inbox_local',
    description: [
      "Search the LOCAL synced index of the user's mailbox (inbox, sent, archive). Unlike Gmail search this matches SUBSTRINGS anywhere — 'Maple' matches 'Maplewood', a half-remembered name still hits — and it is instant with zero quota. Best first stop for partial words, fragments, misspellings, and 'I know an email mentioned X' questions.",
      "All filters AND: text (every word must appear somewhere in subject/from/to/body), from, to, subject, after/before (YYYY-MM-DD), has_attachment. Results are newest-first; ids work with read_email / read_attachment exactly like Gmail search hits.",
      "Every result reports index coverage (message count + date span). If coverage looks thin or predates what you need, fall back to search_email (live Gmail).",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Free text; every whitespace-separated word must appear (substring match, any field).' },
        from: { type: 'string' },
        to: { type: 'string' },
        subject: { type: 'string' },
        after: { type: 'string', description: 'YYYY-MM-DD (user timezone).' },
        before: { type: 'string', description: 'YYYY-MM-DD.' },
        has_attachment: { type: 'boolean' },
        limit: { type: 'number', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  read_email: {
    name: 'read_email',
    description: "Read email content from the user's Gmail. Pass message_id for one full body (plus attachment ids), or thread_id for the whole conversation oldest-first (use for \"has X responded\", back-and-forth, and timeline questions). Get ids from search_email.",
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, thread_id: { type: 'string' } } },
  },
  read_attachment: {
    name: 'read_attachment',
    description: "OPEN and read ANY attachment from the user's Gmail — PDFs, Office files (docx/xlsx/pptx, converted to text), photos/images, text-based files (csv, txt, html, eml, json, ics), even audio/video. Pass the message_id + attachment_id (copy the attachment id EXACTLY as returned by search_email/read_email; pass filename and mime_type too when you have them) and a question saying what to look for, or \"summarize this document\". Returns what the attachment actually contains. If a search hit lists an attachment that could hold the answer, open it with this tool — never conclude a document is missing while an unopened attachment sits in the results. Only legacy pre-2007 Office files (.doc/.xls/.ppt) and archives can't be opened — the tool says so; relay that honestly.",
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, attachment_id: { type: 'string' }, question: { type: 'string', description: 'What to find or answer from the attachment, or "summarize this document".' }, filename: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'number' } }, required: ['message_id', 'attachment_id', 'question'] },
  },
  recall_history: {
    name: 'recall_history',
    description: "Search your own recent chat history with this user (last ~7 days) by keyword — for \"what did we discuss about X\", a detail they mentioned in passing, or context from an earlier conversation. Returns matching messages with who said them and when. Older than that, durable facts live in the user context block instead.",
    inputSchema: { type: 'object', properties: { keyword: { type: 'string', description: 'A word or short phrase to find (a name, a topic, a term).' } }, required: ['keyword'] },
  },
  draft_text: {
    name: 'draft_text',
    description: 'Draft a professional message, note, or letter for the user to send (never sends it). Provide the instructions (what to say and to whom); optionally a tone. Any context to ground it on (a recalled email, a snippet of history) can be folded into the instructions.',
    inputSchema: { type: 'object', properties: { instructions: { type: 'string' }, context: { type: 'string', description: 'Optional grounding text (a recalled email, notes) — do not invent beyond it.' }, tone: { type: 'string', enum: ['standard', 'firm', 'warm'] } }, required: ['instructions'] },
  },
  list_scheduled_outreach: {
    name: 'list_scheduled_outreach',
    description: "List the proactive follow-ups/reminders you currently have SCHEDULED to send the user later (active + paused), soonest first — the read-back of what schedule_followup queued. Use for \"what follow-ups are set\", \"is anything scheduled\", \"what are you about to send me\". Optional within_days limits the horizon. Read-only enumeration — it never fires, edits, pauses, or cancels anything.",
    inputSchema: { type: 'object', properties: { within_days: { type: 'number', description: 'Optional: only those firing within this many days.' } } },
  },
  outreach_failures: {
    name: 'outreach_failures',
    description: "List proactive follow-ups that FAILED to send or are stuck mid-retry — the reliability check that list_scheduled_outreach (active/paused queue) structurally can't show. Use to answer \"did any reminder not go out\" or to proactively surface a silent send failure. Returns each follow-up, its failure state (gave up vs retrying), last attempt date, and the error. Read-only.",
    inputSchema: { type: 'object', properties: {} },
  },
  schedule_followup: {
    name: 'schedule_followup',
    description: [
      'Queue a proactive follow-up you will send the user LATER, unprompted, at a future time. Use this ONLY for a concrete, grounded future obligation you actually found (e.g. a deadline three days out, a document due friday). Never schedule speculatively.',
      'For a one-time nudge set schedule_kind="once" and fire_at to an absolute ISO 8601 timestamp; for a recurring one set schedule_kind="cron" with a 5-field cron and timezone.',
      'Write instruction as a clear note for the future message: what to flag, with the concrete date/fact. Set needs_ops=true with an ops_kind only if the follow-up needs fresh data re-pulled at that time. Pass a stable dedupe_key so the same follow-up is not queued twice across runs.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'What to flag at fire time, with the concrete fact/date.' },
        schedule_kind: { type: 'string', enum: ['once', 'cron'] },
        fire_at: { type: 'string', description: 'Absolute ISO 8601 timestamp for a one-time follow-up.' },
        cron: { type: 'string', description: '5-field cron expression for a recurring follow-up.' },
        timezone: { type: 'string', description: 'IANA timezone (default America/Chicago).' },
        needs_ops: { type: 'boolean', description: 'true if the follow-up needs fresh data re-pulled at fire time.' },
        ops_kind: { type: 'string', description: 'Hint for what data to pull when needs_ops is true.' },
        title: { type: 'string', description: 'Short label for the follow-up.' },
        dedupe_key: { type: 'string', description: 'Stable key to avoid scheduling the same follow-up twice.' },
      },
      required: ['instruction', 'schedule_kind'],
    },
  },
};

// Primary tools per task kind. This is EMPHASIS, not a wall: `general` — the catch-all — gets the
// full read-only union so one investigation can combine the web + the user's inbox + chat recall.
const KIND_TOOLS: Record<TaskKind, string[]> = {
  web_research: ['read_url', 'schedule_followup'],
  document_read: ['search_email', 'search_inbox_local', 'read_email', 'read_attachment', 'gmail_docs', 'recall_history', 'schedule_followup'],
  draft: ['draft_text', 'search_email', 'read_email', 'recall_history'],
  // MM-only kind: a media_read task never enters the Ops loop (it runs runMmTask). The entry exists
  // only because Record<TaskKind, …> is total.
  media_read: [],
  // Reflexion-only kind: a memory_update task never enters the Ops loop either (it runs
  // runReflexion, silent). Total-Record placeholder, same as media_read.
  memory_update: [],
  general: Object.keys(ALL_OPS_TOOLS), // full union — see note above
};

/** Canonical flatten order for a task's chat attachments — the <chat_attachments> manifest in the
 *  task prompt and the `attachment` index arg of read_chat_attachment MUST agree, so both go through
 *  this. Order mirrors MM's buildMediaContent: images → video → audio → docs. Exported for tests. */
export function flattenChatMedia(media?: IncomingMedia): Array<{ item: ExtractedMedia; noun: string }> {
  if (!media) return [];
  return [
    ...media.images.map(item => ({ item, noun: 'photo/image' })),
    ...media.video.map(item => ({ item, noun: 'video' })),
    ...media.audio.map(item => ({ item, noun: 'voice memo/audio' })),
    ...media.docs.map(item => ({ item, noun: 'document' })),
  ];
}

// Deliberately NOT in ALL_OPS_TOOLS: `general` takes the full union (Object.keys above), and this
// tool must exist only when the task actually carries chat media — toolsForKind appends it then,
// for EVERY kind, so a document_read or web_research run grounded in a texted file can open it too.
export const CHAT_ATTACHMENT_TOOL: LlmToolDef = {
  name: 'read_chat_attachment',
  description:
    'OPEN and read a file the user texted in this chat — the <chat_attachments> manifest in your task ' +
    'prompt lists them, numbered. PDFs, photos/images, Office files (converted to text), text files, ' +
    'even audio/video. Pass the attachment number from the manifest and a question saying what to find, ' +
    'or "summarize this document". Use it whenever the answer lives INSIDE the file; when a ' +
    '<media_analysis> block already covers the question, answer from that and re-open the file only for ' +
    'detail beyond it. If the read fails (expired link, too large, did not come through), the tool says ' +
    'so — relay that honestly in your ANSWER and ask the user to resend the file. Chat files only; ' +
    'email attachments still go through read_attachment with a message_id.',
  inputSchema: {
    type: 'object',
    properties: {
      attachment: { type: 'number', description: 'The attachment number from the <chat_attachments> manifest (1-based). Omit when only one file is listed.' },
      question: { type: 'string', description: 'What to find or answer from the file, or "summarize this document".' },
    },
    required: ['question'],
  },
};

export function toolsForKind(kind: TaskKind, opts: { chatMediaCount?: number } = {}): LlmToolDef[] {
  const base = (KIND_TOOLS[kind] ?? KIND_TOOLS.general).map(n => ALL_OPS_TOOLS[n]);
  return (opts.chatMediaCount ?? 0) > 0 ? [...base, CHAT_ATTACHMENT_TOOL] : base;
}

/** The kind's primary tools, for the task prompt ("lead with these, reach wider if needed"). */
export function primaryToolNamesForKind(kind: TaskKind): string[] {
  if (kind === 'general') return [];
  return KIND_TOOLS[kind] ?? [];
}

// Web search (Anthropic server tool) is enabled only for the open-reasoning kinds; the model
// self-gates whether it actually searches. Gmail/DB-grounded kinds never search (privacy + cost).
const WEB_SEARCH_ENABLED = process.env.OPS_WEB_SEARCH_ENABLED !== 'false';
export const OPS_WEB_SEARCH_MAX_USES = Number(process.env.OPS_WEB_SEARCH_MAX_USES || 3);
const KIND_WEB_SEARCH: Partial<Record<TaskKind, boolean>> = {
  web_research: true,
  general: true,
};

export function webSearchForKind(kind: TaskKind): boolean {
  return WEB_SEARCH_ENABLED && !!KIND_WEB_SEARCH[kind];
}

// Grounding enforcement is a property of the KIND, independent of the web-search toggle. Corpus-
// grounded kinds (the user's inbox/attachments, a draft's supplied context) MUST have every hard
// fact appear in tool output. Open-reasoning/web kinds ('general', 'web_research') don't enforce by
// default — their facts can legitimately come from web results not captured in the tool corpus —
// UNLESS the task sets forceGrounding (the routing gate does, to keep a pushed-in data question
// honest). Deliberately NOT tied to OPS_WEB_SEARCH_ENABLED, so disabling web search never starts
// suppressing valid reasoning answers.
const KIND_ENFORCES_GROUNDING: Partial<Record<TaskKind, boolean>> = {
  document_read: true, draft: true,
};
export function enforceGroundingForKind(kind: TaskKind): boolean {
  return !!KIND_ENFORCES_GROUNDING[kind];
}

/** Coerce a model-supplied string-array arg (providers sometimes JSON-stringify arrays). */
function asStringArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const out = v.map(x => String(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return undefined;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) {
        const out = parsed.map(x => String(x).trim()).filter(Boolean);
        return out.length ? out : undefined;
      }
    } catch { /* not JSON — treat as a single entry */ }
    return [t];
  }
  return undefined;
}

/** Optional-string coercion: empty/nullish → undefined. */
function optStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

// ── search result rendering (exported for tests) ────────────────────────────

function emailHitLine(e: DealEmail): string {
  const preview = e.bodyText.replace(/\s+/g, ' ').trim().slice(0, 400);
  return `- id=${e.id} | thread=${e.threadId} | ${e.date} | from: ${e.from} | subj: ${e.subject}` +
    (preview ? `\n  body: ${preview}${e.bodyText.length > 400 ? ' …[read_email for the rest]' : ''}` : '') +
    (e.attachments.length ? `\n  attachments: ${e.attachments.map(a => `${a.filename} (id=${a.attachmentId}, ${a.mimeType}, ${a.sizeBytes}b)`).join('; ')}` : '');
}

const trimQ = (q: string) => (q.length > 220 ? `${q.slice(0, 220)}…` : q);

/** Render a live Gmail search outcome: effective queries + counts first, then the hits. */
export function renderGmailSearch(res: EmailSearchResult): string {
  const head: string[] = [];
  for (const v of res.perVariant) head.push(`searched [${v.label}]: ${trimQ(v.q)} → ${v.count} hit(s)`);
  if (res.defaultWindowApplied) {
    head.push(`(default window ${res.defaultWindowApplied} was applied — pass newer_than_days: 0 or after/before to change it)`);
  }
  if (res.usedLadder) {
    head.push(`primary queries found nothing — auto-broadened [${res.usedLadder.label}]: ${trimQ(res.usedLadder.q)} → ${res.usedLadder.count} hit(s); results below are from that broader net, verify they match the ask`);
  } else if (res.ladderTrail.length) {
    head.push(`auto-broadening also found nothing (tried: ${res.ladderTrail.map(l => l.label).join(', ')})`);
  }

  if (!res.emails.length) {
    return [
      'no matching emails found.',
      ...head,
      'next moves: different keywords in `queries` (sender domain, doc type, subject words), search_inbox_local (substring matching over the synced mailbox), newer_than_days: 0 for all time.',
      'IMPORTANT: "not found by these queries" is NOT "does not exist" — try materially different formulations before concluding absence, and list what you searched in the answer.',
    ].join('\n');
  }

  const tail: string[] = [];
  if (res.unhydrated > 0) tail.push(`(+${res.unhydrated} more match(es) listed but not shown — narrow the query, or continue with page_token)`);
  if (res.nextPageToken) tail.push(`MORE RESULTS EXIST — pass page_token: "${res.nextPageToken}" to continue. Do this before reporting completion or absence.`);
  return [...head, `${res.emails.length} result(s), newest first:`, ...res.emails.map(emailHitLine), ...tail].join('\n');
}

/** Render a local-index search outcome, always leading with coverage so staleness is visible. */
export function renderLocalSearch(hits: IndexedEmail[], stats: { count: number; oldestMs: number | null; newestMs: number | null }): string {
  const span = stats.count && stats.oldestMs && stats.newestMs
    ? `${new Date(stats.oldestMs).toISOString().slice(0, 10)} → ${new Date(stats.newestMs).toISOString().slice(0, 10)}`
    : 'empty';
  const coverage = `local index coverage: ${stats.count} message(s), ${span}`;
  if (!stats.count) {
    return `${coverage}\nthe index has not been backfilled yet for this account — use search_email (live Gmail) instead.`;
  }
  if (!hits.length) {
    return `${coverage}\nno local matches. Substring matching already applied — try fewer/shorter terms, or search_email (live Gmail) in case the mail predates the index.`;
  }
  const lines = hits.map(e => {
    const preview = (e.bodyText || e.snippet).replace(/\s+/g, ' ').trim().slice(0, 300);
    return `- id=${e.id} | thread=${e.threadId} | ${new Date(e.internalDate).toISOString()} | from: ${e.from} | subj: ${e.subject}` +
      (preview ? `\n  body: ${preview}…[read_email for the rest]` : '') +
      (e.attachments.length ? `\n  attachments: ${e.attachments.map(a => `${a.filename} (id=${a.attachmentId}, ${a.mimeType}, ${a.sizeBytes}b)`).join('; ')}` : '');
  });
  return [coverage, `${hits.length} result(s), newest first:`, ...lines].join('\n');
}

/** Render the scheduled proactive-outreach queue (list_scheduled_outreach). Exported for tests. */
export function renderScheduledOutreach(rows: Automation[], nowMs: number = Date.now(), tz?: string): string {
  if (!rows.length) return 'no proactive follow-ups are scheduled right now';
  const lines: string[] = [`${rows.length} scheduled follow-up(s), soonest first:`];
  for (const a of rows) {
    const when = a.scheduleKind === 'cron'
      ? `recurring (cron ${a.cron ?? '?'}, ${a.timezone})`
      : (() => { const rel = describeDateVsToday(a.nextRunAt, nowMs, tz); return `once on ${a.nextRunAt.slice(0, 10)}${rel ? ` (${rel})` : ''}`; })();
    const title = (a.title || a.instruction).slice(0, 90);
    const paused = a.status === 'paused' ? ' [PAUSED]' : '';
    const fired = a.runCount > 0 ? ` | fired ${a.runCount}x` : '';
    lines.push(`- ${title}${paused} | ${when}${fired}`);
  }
  lines.push('NOTE: these are the proactive messages you are set to send. Read-only — reporting them does not change, pause, or cancel any of them.');
  return lines.join('\n');
}

/** Render failed/stuck proactive outreach (outreach_failures). Exported for tests. */
export function renderOutreachFailures(rows: Automation[]): string {
  if (!rows.length) return 'no failed or stuck follow-ups — every scheduled outreach is healthy';
  const lines: string[] = [`${rows.length} follow-up(s) that failed to send or are stuck retrying:`];
  for (const a of rows) {
    const title = (a.title || a.instruction).slice(0, 90);
    const state = a.status === 'failed' ? 'GAVE UP (failed)' : `retrying (${a.attempts} failed attempt(s))`;
    const last = a.lastRunAt ? `, last tried ${a.lastRunAt.slice(0, 10)}` : '';
    const err = a.lastError ? ` — ${a.lastError.slice(0, 160)}` : '';
    lines.push(`- ${title} | ${state}${last}${err}`);
  }
  lines.push('NOTE: these proactive sends did NOT reach the user. Surface them so they know; read-only — actually resending or rescheduling is a separate action.');
  return lines.join('\n');
}

/** Resolve the user's IANA timezone for date compilation (falls back to the app default). Their
 *  explicit `agent_tz` preference is the one signal — no location inference. Exported so the Ops
 *  loop's clock anchor (buildTaskPrompt) reads the SAME zone the tools render dates in. */
export async function userTz(handle: string): Promise<string> {
  try {
    const m = await getMemory(handle);
    return (m?.prefs?.agent_tz as string | undefined) || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface ToolOutcome {
  result: string;
  needsAuth?: boolean;
}

const URL_FETCH_TIMEOUT_MS = Number(process.env.OPS_READ_URL_TIMEOUT_MS || 15_000);
const URL_TEXT_CAP = 8000;

/** Fetch a web page and return its readable text (tags crudely stripped, capped). Error-shaped
 *  string on any failure so the model can react instead of the run throwing. */
async function fetchUrlText(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return `error: "${rawUrl}" is not a valid URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `error: only http/https URLs can be read (got ${url.protocol})`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; assistant/1.0)', accept: 'text/html,text/plain,*/*' },
    });
    if (!res.ok) return `error: fetching ${url.hostname} returned HTTP ${res.status}`;
    const ctype = res.headers.get('content-type') || '';
    const raw = await res.text();
    // Only HTML/text is readable; anything else (pdf/binary) we can't crudely extract here.
    if (ctype && !/text\/|application\/(xhtml|json|xml)/i.test(ctype)) {
      return `error: ${url.hostname} returned ${ctype.split(';')[0]}, which read_url can't extract as text`;
    }
    const text = stripHtml(raw);
    if (!text) return `error: no readable text found at ${url.hostname}`;
    const capped = text.length > URL_TEXT_CAP ? `${text.slice(0, URL_TEXT_CAP)}\n…[truncated at ${URL_TEXT_CAP} chars]` : text;
    return `URL: ${url.toString()}\n\n${capped}`;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return `error: fetching ${url.hostname} timed out after ${URL_FETCH_TIMEOUT_MS}ms`;
    return `error: could not fetch ${url.hostname} (${(err as Error)?.message ?? 'network error'})`;
  } finally {
    clearTimeout(timer);
  }
}

/** Crude HTML→text: drop script/style/head, strip tags, decode a few entities, collapse whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function runOpsTool(name: string, input: Record<string, unknown>, task: OpsTask): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'read_url': {
        return { result: await fetchUrlText(String(input.url ?? '')) };
      }
      case 'gmail_docs': {
        return { result: getGmailDocs(input.section ? String(input.section) : undefined) };
      }
      case 'search_email': {
        const nRaw = input.newer_than_days;
        const n = nRaw === undefined || nRaw === null || nRaw === '' ? undefined : Number(nRaw);
        const spec: EmailSearchSpec = {
          query: optStr(input.query),
          queries: asStringArray(input.queries),
          from: optStr(input.from),
          to: optStr(input.to),
          subject: optStr(input.subject),
          phrase: optStr(input.phrase),
          terms: asStringArray(input.terms),
          filename: optStr(input.filename),
          hasAttachment: input.has_attachment === true,
          after: optStr(input.after),
          before: optStr(input.before),
          newerThanDays: n !== undefined && Number.isFinite(n) ? Math.max(0, n) : undefined,
          includeSpamTrash: input.include_spam_trash === true,
          maxResults: input.max_results ? Math.min(Math.max(Number(input.max_results), 1), 50) : undefined,
          pageToken: optStr(input.page_token),
          timezone: await userTz(task.agentHandle),
        };
        const res = await searchEmails(task.agentHandle, spec);
        return { result: renderGmailSearch(res) };
      }
      case 'search_inbox_local': {
        const tz = await userTz(task.agentHandle);
        const after = optStr(input.after);
        const before = optStr(input.before);
        const afterMs = after ? dateTimeInZone(after.replace(/\//g, '-'), { hour: 0 }, tz) : NaN;
        const beforeMs = before ? dateTimeInZone(before.replace(/\//g, '-'), { hour: 0 }, tz) : NaN;
        const [hits, stats] = await Promise.all([
          searchEmailIndex(task.agentHandle, {
            text: optStr(input.text),
            from: optStr(input.from),
            to: optStr(input.to),
            subject: optStr(input.subject),
            afterMs: Number.isNaN(afterMs) ? undefined : afterMs,
            beforeMs: Number.isNaN(beforeMs) ? undefined : beforeMs,
            hasAttachment: input.has_attachment === true,
            limit: input.limit ? Math.min(Math.max(Number(input.limit), 1), 50) : undefined,
          }),
          emailIndexStats(task.agentHandle),
        ]);
        return { result: renderLocalSearch(hits, stats) };
      }
      case 'read_email': {
        const threadId = input.thread_id ? String(input.thread_id) : '';
        if (threadId) {
          const msgs = await fetchThread(task.agentHandle, threadId);
          if (!msgs.length) return { result: 'no messages found in that thread' };
          return { result: msgs.map(m =>
            `--- ${m.date} | from: ${m.from} | subj: ${m.subject}\n${m.bodyText.trim() || '(no body text)'}` +
            (m.attachments.length ? `\nattachments: ${m.attachments.map(a => `${a.filename} (id=${a.attachmentId})`).join('; ')}` : '')
          ).join('\n\n') };
        }
        const messageId = input.message_id ? String(input.message_id) : '';
        if (!messageId) return { result: 'read_email needs a message_id or thread_id' };
        const msg = await fetchMessageById(task.agentHandle, messageId);
        if (!msg) return { result: 'no message found with that id' };
        return { result:
          `From: ${msg.from}\nTo: ${msg.to.join(', ')}\nDate: ${msg.date}\nSubject: ${msg.subject}\nThread: ${msg.threadId}\n\n${msg.bodyText.trim() || '(no body text)'}` +
          (msg.attachments.length ? `\n\nattachments: ${msg.attachments.map(a => `${a.filename} (id=${a.attachmentId}, ${a.mimeType}, ${a.sizeBytes}b)`).join('; ')}` : '') };
      }
      case 'read_attachment': {
        const r = await readEmailAttachment({
          handle: task.agentHandle,
          messageId: String(input.message_id),
          attachmentId: String(input.attachment_id),
          question: String(input.question ?? ''),
          filename: input.filename ? String(input.filename) : undefined,
          mimeType: input.mime_type ? String(input.mime_type) : undefined,
          sizeBytes: input.size_bytes ? Number(input.size_bytes) : undefined,
          chatId: task.chatId,
          taskId: task.id,
        });
        if (r.status !== 'ok' || !r.answer) return { result: `attachment read ${r.status}${r.warning ? `: ${r.warning}` : ''}` };
        return { result: r.answer };
      }
      case 'read_chat_attachment': {
        const flat = flattenChatMedia(task.media);
        if (!flat.length) {
          return { result: 'no chat attachments are on this task — the user did not text a file with this request. If the answer depends on one, say so in the ANSWER and ask them to send it.' };
        }
        const idx = Math.trunc(Number(input.attachment ?? 1));
        const chosen = flat[idx - 1];
        if (!chosen) return { result: `no attachment #${idx} — the manifest lists ${flat.length} file(s), numbered from 1` };
        const r = await readChatAttachment({
          media: chosen.item,
          question: String(input.question ?? ''),
          handle: task.agentHandle,
          chatId: task.chatId,
          taskId: task.id,
        });
        if (r.status !== 'ok' || !r.answer) return { result: `attachment read ${r.status}${r.warning ? `: ${r.warning}` : ''}` };
        return { result: r.answer };
      }
      case 'recall_history': {
        const hits = await searchMessages(task.chatId, String(input.keyword ?? ''));
        if (!hits.length) return { result: 'nothing in the recent chat history matches that — it may be older than the retention window, so the honest move is to ask the user to restate it' };
        return { result: hits.map(m => {
          const when = m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : '';
          const who = m.role === 'assistant' ? 'you' : 'user';
          return `[${when}] ${who}: ${m.content.slice(0, 300)}`;
        }).join('\n') };
      }
      case 'draft_text': {
        const d = await draftText(task.agentHandle, {
          instructions: String(input.instructions ?? ''),
          context: input.context ? String(input.context) : undefined,
          tone: input.tone as 'standard' | 'firm' | 'warm' | undefined,
          chatId: task.chatId,
          taskId: task.id,
        });
        if (d.status !== 'ok') return { result: 'draft failed' };
        return { result: `Subject: ${d.subject}\n\n${d.body}\n\n(context used: ${d.contextUsed.join(', ') || 'none'})` };
      }
      case 'list_scheduled_outreach': {
        // reflexion rows are the silent internal curator — never surfaced to the user.
        let rows = (await listAutomations(task.agentHandle)).filter(a => a.source !== 'reflexion');
        if (input.within_days != null && input.within_days !== '') {
          const horizon = Date.now() + Math.max(0, Number(input.within_days)) * 86_400_000;
          rows = rows.filter(a => Date.parse(a.nextRunAt) <= horizon);
        }
        const tz = await userTz(task.agentHandle);
        return { result: renderScheduledOutreach(rows, Date.now(), tz) };
      }
      case 'outreach_failures': {
        const rows = await listFailedAutomations(task.agentHandle);
        return { result: renderOutreachFailures(rows) };
      }
      case 'schedule_followup': {
        const instruction = String(input.instruction ?? '').trim();
        if (!instruction) return { result: 'schedule_followup needs an instruction' };
        const timezone = input.timezone ? String(input.timezone) : 'America/Chicago';
        const common = {
          agentHandle: task.agentHandle,
          chatId: task.chatId,
          source: 'ops' as const,
          title: input.title ? String(input.title) : null,
          instruction,
          needsOps: input.needs_ops === true,
          opsKind: input.ops_kind ? String(input.ops_kind) : null,
          respectQuietHours: true, // system-initiated nudge, not a user-chosen time
          timezone,
        };
        let created;
        if (input.schedule_kind === 'cron') {
          const cron = String(input.cron ?? '');
          if (!cron || !isValidCron(cron, timezone)) return { result: 'invalid cron expression; not scheduled' };
          const dedupeKey = input.dedupe_key ? String(input.dedupe_key) : deriveDedupeKey('ops', instruction, cron);
          created = await createAutomation({ ...common, scheduleKind: 'cron', cron, dedupeKey });
        } else {
          const ts = Date.parse(String(input.fire_at ?? ''));
          if (Number.isNaN(ts) || ts <= Date.now()) return { result: 'fire_at must be a future ISO timestamp; not scheduled' };
          const fireAtIso = new Date(ts).toISOString();
          const dedupeKey = input.dedupe_key ? String(input.dedupe_key) : deriveDedupeKey('ops', instruction, fireAtIso);
          created = await createAutomation({ ...common, scheduleKind: 'once', nextRunAt: fireAtIso, dedupeKey });
        }
        return { result: created ? 'follow-up scheduled' : 'could not schedule the follow-up (storage error)' };
      }
      default:
        return { result: `unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof GmailReauthRequired) return { result: 'GMAIL_NOT_CONNECTED', needsAuth: true };
    console.error(`[ops] tool ${name} failed`, err);
    // The error string goes back to the MODEL, which usually routes around it — so a route that is
    // failing every call is invisible from the outside. Reported per failure; the sink folds repeats
    // of the same tool+message into one counted row, so a wedged integration costs ~1 row/minute.
    reportError({
      source: 'ops', category: 'tool_failure', severity: 'warn', err,
      detail: { tool: name }, chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
    });
    return { result: `tool ${name} error: ${(err as Error)?.message ?? 'unknown'}` };
  }
}
