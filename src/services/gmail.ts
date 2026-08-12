// Gmail read layer (inventory buckets 1, 6, 8). Pure data — no LLM calls.
//
// Reliability contract (2026-07 reliability review):
//   - every Gmail API call retries transient failures (429/5xx/network) with backoff+jitter
//   - date operators compile to epoch SECONDS in the user's timezone (Gmail interprets
//     `after:YYYY/MM/DD` as midnight PST — a silent off-by-hours window for our users)
//   - searchEmails runs a PLAN: model-supplied variants in parallel, then a deterministic
//     broadening ladder when everything comes back empty — so "0 hits" reaching the model
//     means the ladder already tried the obvious relaxations, not that one query missed
//   - results carry the effective queries + counts so the model can see (and debug) what ran
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { getGmailClientForHandle, GmailReauthRequired } from '../oauth/google.js';
import { dateTimeInZone, DEFAULT_TZ } from '../pipeline/zonedTime.js';

export interface AttachmentRef {
  attachmentId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DealEmail {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  date: string; // ISO-ish (raw header)
  internalDate: number; // epoch ms (Gmail internalDate) — used for incremental ingestion
  subject: string;
  snippet: string;
  bodyText: string;
  attachments: AttachmentRef[];
  labelIds: string[]; // Gmail labels (e.g. UNREAD) — used to skip already-read mail before judging
}

export interface FindEmailsOptions {
  query?: string;
  address?: string;
  clientName?: string;
  clientEmail?: string;
  maxResults?: number;
  newerThanDays?: number;
}

// ── transient-failure retry ─────────────────────────────────────────────────
// googleapis does NOT retry by default; a 429/500 used to surface as a tool-error string that
// burned an Ops step. 3 attempts, 1s/2s backoff + jitter (Google's guidance: start >= 1s).
const RETRY_ATTEMPTS = Number(process.env.GMAIL_RETRY_ATTEMPTS || 3);

function errStatus(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const raw = e?.response?.status ?? e?.status ?? e?.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function isTransientGmailError(err: unknown): boolean {
  if (err instanceof GmailReauthRequired) return false;
  const status = errStatus(err);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  // 403 is retryable ONLY for rate-limit reasons (never for real permission errors).
  if (status === 403 && /rate ?limit|user rate|quota/.test(msg)) return true;
  return /econnreset|etimedout|eai_again|socket hang up|network|fetch failed/.test(msg);
}

/** Run a Gmail API call with bounded retry on transient failures. Exported for the OAuth layer. */
export async function withGmailRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientGmailError(err) || attempt === RETRY_ATTEMPTS - 1) throw err;
      const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
      console.warn(`[gmail] transient ${label} failure (status ${errStatus(err) ?? '?'}); retry ${attempt + 1}/${RETRY_ATTEMPTS - 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── query compilation ───────────────────────────────────────────────────────

const STREET_ABBREV: Record<string, string> = {
  street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln',
  road: 'rd', court: 'ct', place: 'pl', terrace: 'ter', circle: 'cir',
};

/** Build an address-anchored Gmail search clause that tolerates St/Street style variance. */
export function buildAddressQuery(address: string): string {
  const m = address.trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return `"${address}"`;
  const [, number, rest] = m;
  const words = rest.split(/\s+/);
  const variants = new Set<string>([`${number} ${rest}`]);
  const last = words[words.length - 1]?.toLowerCase().replace(/\./g, '');
  for (const [full, abbr] of Object.entries(STREET_ABBREV)) {
    if (last === full || last === abbr) {
      const base = words.slice(0, -1).join(' ');
      variants.add(`${number} ${base} ${full}`);
      variants.add(`${number} ${base} ${abbr}`);
    }
  }
  return '(' + [...variants].map(v => `"${v}"`).join(' OR ') + ')';
}

/** Loosest useful address anchor: street number + first street word ("1042 Maple"). */
export function looseAddressQuery(address: string): string | null {
  const m = address.trim().match(/^(\d+)\s+([A-Za-z0-9]+)/);
  if (!m) return null;
  return `"${m[1]} ${m[2]}"`;
}

/** Quote a value for a Gmail operator when it contains whitespace. */
function maybeQuote(v: string): string {
  const t = v.trim();
  return /\s/.test(t) && !/^".*"$/.test(t) ? `"${t}"` : t;
}

/**
 * Compile an `after:`/`before:` clause to epoch SECONDS in the given timezone.
 * Gmail interprets `after:YYYY/MM/DD` as midnight PST — the epoch form is the only
 * timezone-safe one Google documents. Accepts YYYY-MM-DD or YYYY/MM/DD. Returns null
 * for malformed dates (caller drops the clause rather than emitting a broken one).
 */
export function dateClause(kind: 'after' | 'before', ymd: string, tz: string = DEFAULT_TZ): string | null {
  const norm = ymd.trim().replace(/\//g, '-');
  const ms = dateTimeInZone(norm, { hour: 0 }, tz);
  if (Number.isNaN(ms)) return null;
  return `${kind}:${Math.floor(ms / 1000)}`;
}

/** Typed search request. Everything optional; the compiler builds correct Gmail syntax. */
export interface EmailSearchSpec {
  address?: string;
  client?: string;            // person name (quoted) or email (from:/to: either direction)
  query?: string;             // raw Gmail clause (escape hatch / legacy)
  queries?: string[];         // alternate raw formulations, each ANDed with the structural clauses
  from?: string;
  to?: string;
  subject?: string;
  phrase?: string;            // exact phrase (quoted)
  terms?: string[];           // body keywords, ANDed
  filename?: string;
  hasAttachment?: boolean;
  after?: string;             // YYYY-MM-DD, interpreted in `timezone`
  before?: string;            // YYYY-MM-DD, interpreted in `timezone`
  newerThanDays?: number;     // 0 = unbounded; undefined = default window when no other date signal
  includeSpamTrash?: boolean;
  maxResults?: number;        // hydrated messages per page (default 20, cap 25)
  pageToken?: string;
  timezone?: string;
  /** Skip the zero-hit broadening ladder (legacy non-Ops callers: an auto-broadened result
   *  could feed wrong contacts into party maps / client history without a model to vet it). */
  noLadder?: boolean;
}

/** Default recency window (days) applied ONLY when the spec carries no date signal at all. */
export const DEFAULT_SEARCH_WINDOW_DAYS = Number(process.env.GMAIL_SEARCH_DEFAULT_WINDOW_DAYS || 365);

export interface CompiledQuery {
  q: string;
  label: string;
  includeSpamTrash: boolean;
}

export interface SearchPlan {
  variants: CompiledQuery[];        // run in parallel; results merged
  ladder: CompiledQuery[];          // tried in order only if every variant returns nothing
  defaultWindowApplied: string | null; // e.g. "newer_than:365d" when the default window kicked in
}

interface ClauseSet {
  address?: string;
  loose?: boolean;       // use the loose address anchor instead of the variant group
  client?: string;
  raw?: string;
  fixed: string[];       // from/to/subject/phrase/terms/filename/attachment clauses
  dates: string[];
  spam: boolean;
}

function renderClauses(c: ClauseSet): string {
  const parts: string[] = [];
  if (c.address) {
    const anchor = c.loose ? (looseAddressQuery(c.address) ?? buildAddressQuery(c.address)) : buildAddressQuery(c.address);
    parts.push(anchor);
  }
  if (c.client) {
    parts.push(c.client.includes('@') ? `(from:${c.client} OR to:${c.client})` : `"${c.client}"`);
  }
  if (c.raw) parts.push(`(${c.raw})`);
  parts.push(...c.fixed, ...c.dates);
  return parts.join(' ').trim();
}

/**
 * Build the full search plan: primary variants (the model's formulations, or the single
 * structural query) plus a deterministic broadening ladder for the zero-hit case. Pure —
 * unit-testable without a Gmail client.
 */
export function buildSearchPlan(spec: EmailSearchSpec): SearchPlan {
  const tz = spec.timezone || DEFAULT_TZ;
  const fixed: string[] = [];
  if (spec.from) fixed.push(`from:${maybeQuote(spec.from)}`);
  if (spec.to) fixed.push(`to:${maybeQuote(spec.to)}`);
  if (spec.subject) fixed.push(`subject:${maybeQuote(spec.subject)}`);
  if (spec.phrase) fixed.push(`"${spec.phrase.replace(/^"|"$/g, '')}"`);
  for (const t of spec.terms ?? []) if (t.trim()) fixed.push(maybeQuote(t));
  if (spec.filename) fixed.push(`filename:${maybeQuote(spec.filename)}`);
  if (spec.hasAttachment) fixed.push('has:attachment');

  // Date clauses: explicit after/before (epoch-compiled) win; else newer_than_days
  // (0 = unbounded); else the default window — flagged so the caller can report it.
  const dates: string[] = [];
  let defaultWindowApplied: string | null = null;
  const afterC = spec.after ? dateClause('after', spec.after, tz) : null;
  const beforeC = spec.before ? dateClause('before', spec.before, tz) : null;
  if (afterC) dates.push(afterC);
  if (beforeC) dates.push(beforeC);
  if (!afterC && !beforeC) {
    if (spec.newerThanDays === undefined) {
      // Legacy raw queries may carry their own date operator — don't stack the default on top.
      const rawHasDate = /\b(after:|before:|newer_than:|older_than:)/.test(`${spec.query ?? ''} ${(spec.queries ?? []).join(' ')}`);
      if (!rawHasDate) {
        defaultWindowApplied = `newer_than:${DEFAULT_SEARCH_WINDOW_DAYS}d`;
        dates.push(defaultWindowApplied);
      }
    } else if (spec.newerThanDays > 0) {
      dates.push(`newer_than:${Math.round(spec.newerThanDays)}d`);
    }
    // newerThanDays === 0 → unbounded, no clause.
  }

  const base: ClauseSet = {
    address: spec.address,
    client: spec.client,
    raw: spec.query,
    fixed,
    dates,
    spam: spec.includeSpamTrash === true,
  };

  // Primary variants: one per model-supplied formulation (capped), else the single base query.
  const rawVariants = (spec.queries ?? []).map(q => q.trim()).filter(Boolean).slice(0, 5);
  const variants: CompiledQuery[] = rawVariants.length
    ? rawVariants.map((raw, i) => ({
        q: renderClauses({ ...base, raw }),
        label: rawVariants.length > 1 ? `variant-${i + 1}` : 'base',
        includeSpamTrash: base.spam,
      }))
    : [{ q: renderClauses(base), label: 'base', includeSpamTrash: base.spam }];
  if (spec.query && rawVariants.length) {
    variants.unshift({ q: renderClauses(base), label: 'base', includeSpamTrash: base.spam });
  }
  // Dedupe identical formulations (a model-supplied variant can collide with the base).
  const seenQ = new Set<string>();
  const dedupedVariants = variants.filter(v => (seenQ.has(v.q) ? false : (seenQ.add(v.q), true)));
  variants.length = 0;
  variants.push(...dedupedVariants);

  // Broadening ladder — each step relaxes ONE dimension of the base; the last is maximum
  // recall. When the model searched via queries[] alternates, keep the FIRST formulation's
  // keywords through the intermediate steps (a date/client problem shouldn't cost the keyword
  // anchor); only the final wide-open step drops keywords entirely (they may simply be wrong).
  const ladderBase: ClauseSet = { ...base, raw: base.raw ?? rawVariants[0] };
  const ladder: CompiledQuery[] = [];
  const push = (c: ClauseSet, label: string, spam = c.spam) => {
    const q = renderClauses(c);
    if (!q) return;
    if (variants.some(v => v.q === q && v.includeSpamTrash === spam)) return;
    if (ladder.some(l => l.q === q && l.includeSpamTrash === spam)) return;
    ladder.push({ q, label, includeSpamTrash: spam });
  };
  if (ladderBase.client && (ladderBase.address || ladderBase.raw || fixed.length)) {
    push({ ...ladderBase, client: undefined }, 'without-client');
  }
  if (dates.length) {
    push({ ...ladderBase, dates: [] }, 'all-time');
  }
  if (ladderBase.address && looseAddressQuery(ladderBase.address)) {
    push({ ...ladderBase, loose: true }, 'loose-address');
  }
  // Last resort: everything relaxed at once, spam/trash included, keywords dropped.
  push({ ...ladderBase, raw: undefined, client: undefined, dates: [], loose: true }, 'wide-open', true);

  return { variants, ladder: ladder.slice(0, 4), defaultWindowApplied };
}

// ── message hydration helpers ───────────────────────────────────────────────

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const h = payload?.headers?.find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  // Prefer text/plain; recurse into multiparts.
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  if (part.parts) {
    const plain = part.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return decodeBody(plain);
    for (const p of part.parts) {
      const got = decodeBody(p);
      if (got) return got;
    }
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

function collectAttachments(messageId: string, part: gmail_v1.Schema$MessagePart | undefined, out: AttachmentRef[]): void {
  if (!part) return;
  if (part.body?.attachmentId && part.filename) {
    out.push({
      attachmentId: part.body.attachmentId,
      messageId,
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      sizeBytes: part.body.size ?? 0,
    });
  }
  for (const p of part.parts ?? []) collectAttachments(messageId, p, out);
}

/** Hydrate a raw Gmail message into a DealEmail. Shared by the push/history path. */
function messageToDealEmail(msg: gmail_v1.Schema$Message, bodyLimit = 8000): DealEmail {
  const payload = msg.payload;
  const attachments: AttachmentRef[] = [];
  collectAttachments(msg.id!, payload, attachments);
  return {
    id: msg.id!,
    threadId: msg.threadId ?? '',
    from: header(payload, 'From'),
    to: header(payload, 'To').split(',').map(s => s.trim()).filter(Boolean),
    date: header(payload, 'Date'),
    internalDate: Number(msg.internalDate ?? 0),
    subject: header(payload, 'Subject'),
    snippet: msg.snippet ?? '',
    bodyText: decodeBody(payload).slice(0, bodyLimit),
    attachments,
    labelIds: msg.labelIds ?? [],
  };
}

/**
 * Fetch full messages by id with bounded concurrency (5), per-message retry, and per-message
 * resilience: 404/410 = gone for good (skip silently); other failures flag `hadFetchGap` so the
 * caller holds its cursor. `pauseMs` paces bulk hydration under the 6,000 quota-units/user/min
 * budget (messages.get costs 20 units each as of 2026).
 */
async function hydrateByIds(
  gmail: gmail_v1.Gmail,
  ids: string[],
  bodyLimit: number,
  opts: { pauseMs?: number } = {},
): Promise<{ emails: DealEmail[]; hadFetchGap: boolean }> {
  const results: DealEmail[] = [];
  let hadFetchGap = false;
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const fetched = await Promise.all(batch.map(async id => {
      try {
        return await withGmailRetry(`messages.get(${id})`, () =>
          gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
      } catch (err) {
        const status = errStatus(err);
        if (status !== 404 && status !== 410) {
          console.warn(`[gmail] transient fetch failure for message ${id} (status ${status ?? '?'})`);
          hadFetchGap = true;
        }
        return null;
      }
    }));
    for (const f of fetched) {
      if (f?.data?.id) results.push(messageToDealEmail(f.data, bodyLimit));
    }
    if (opts.pauseMs && i + 5 < ids.length) await sleep(opts.pauseMs);
  }
  return { emails: results, hadFetchGap };
}

// ── search execution ────────────────────────────────────────────────────────

export interface EmailSearchResult {
  emails: DealEmail[];                                       // hydrated, deduped, newest first
  perVariant: { label: string; q: string; count: number }[]; // effective queries + list counts
  /** Every broadening step attempted (in order) with its count; empty when the ladder never ran. */
  ladderTrail: { label: string; q: string; count: number }[];
  /** The ladder step whose results are included below, if one hit. */
  usedLadder: { label: string; q: string; count: number } | null;
  totalListed: number;      // distinct message ids seen across variants (before the hydration cap)
  unhydrated: number;       // ids beyond the cap (visible via narrower query or next page)
  nextPageToken: string | null; // only meaningful for single-variant searches
  defaultWindowApplied: string | null;
}

const HYDRATE_CAP = 25;

/**
 * Execute a search plan: primary variants in parallel, deterministic broadening ladder when
 * everything is empty, dedupe across variants, capped hydration, newest-first ordering
 * (Gmail's list order is not a documented contract — we sort by internalDate ourselves).
 */
export async function searchEmails(handle: string, spec: EmailSearchSpec): Promise<EmailSearchResult> {
  const gmail = await getGmailClientForHandle(handle);
  const plan = buildSearchPlan(spec);
  const perPage = Math.min(Math.max(spec.maxResults ?? 20, 1), 50);

  const listOnce = async (v: CompiledQuery, pageToken?: string) => withGmailRetry(`messages.list(${v.label})`, () =>
    gmail.users.messages.list({
      userId: 'me',
      q: v.q,
      maxResults: perPage,
      includeSpamTrash: v.includeSpamTrash || undefined,
      pageToken,
    }));

  // pageToken only composes with a single variant (tokens are per-query).
  const usePageToken = plan.variants.length === 1 ? spec.pageToken : undefined;
  const listed = await Promise.all(plan.variants.map(v => listOnce(v, usePageToken)));

  const perVariant = plan.variants.map((v, i) => ({
    label: v.label,
    q: v.q,
    count: listed[i].data.messages?.length ?? 0,
  }));
  let nextPageToken = plan.variants.length === 1 ? (listed[0].data.nextPageToken ?? null) : null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const l of listed) {
    for (const m of l.data.messages ?? []) {
      if (m.id && !seen.has(m.id)) { seen.add(m.id); ids.push(m.id); }
    }
  }

  // Zero hits everywhere and not paging → walk the broadening ladder, stop at first catch.
  let usedLadder: EmailSearchResult['usedLadder'] = null;
  const ladderTrail: EmailSearchResult['ladderTrail'] = [];
  if (!ids.length && !spec.pageToken && !spec.noLadder) {
    for (const step of plan.ladder) {
      const res = await listOnce(step);
      const found = res.data.messages ?? [];
      const entry = { label: step.label, q: step.q, count: found.length };
      ladderTrail.push(entry);
      if (found.length) {
        usedLadder = entry;
        for (const m of found) if (m.id && !seen.has(m.id)) { seen.add(m.id); ids.push(m.id); }
        nextPageToken = null;
        break;
      }
    }
  }

  const toHydrate = ids.slice(0, Math.min(perPage, HYDRATE_CAP));
  const { emails } = await hydrateByIds(gmail, toHydrate, 20000);
  emails.sort((a, b) => b.internalDate - a.internalDate);

  return {
    emails,
    perVariant,
    ladderTrail,
    usedLadder,
    totalListed: ids.length,
    unhydrated: Math.max(0, ids.length - toHydrate.length),
    nextPageToken,
    defaultWindowApplied: plan.defaultWindowApplied,
  };
}

/**
 * Legacy single-query search, kept for the non-Ops callers (party map, contact enrich,
 * client history, drafting). Same semantics as before — no ladder, no pagination — but now
 * with retry + compiled plan under the hood. Ops itself uses searchEmails.
 */
export async function findDealEmails(handle: string, opts: FindEmailsOptions): Promise<DealEmail[]> {
  const res = await searchEmails(handle, {
    address: opts.address,
    query: opts.query,
    client: opts.clientEmail || opts.clientName,
    newerThanDays: opts.newerThanDays ?? 180,
    maxResults: opts.maxResults ?? 15,
    noLadder: true,
  });
  return res.emails;
}

/**
 * Fetch recent primary-inbox messages for ingestion/triage. Skips Promotions/Social
 * up front (Gmail's own categorization) so triage sees mostly real mail.
 * `afterEpochMs` filters to messages newer than the last processed watermark.
 */
export async function fetchInbox(
  handle: string,
  opts: { newerThanDays?: number; afterEpochMs?: number; maxResults?: number },
): Promise<FetchByIdsResult> {
  const gmail = await getGmailClientForHandle(handle);
  // is:unread — the Judge should only spend a Sonnet call on mail the agent hasn't seen yet, so we
  // never even fetch read mail on this fallback/backstop path (the pipeline applies the same gate
  // per-email for the push/history path, which has no query to filter on).
  const q = ['in:inbox', 'category:primary', 'is:unread', opts.newerThanDays ? `newer_than:${opts.newerThanDays}d` : '']
    .filter(Boolean).join(' ');

  const list = await withGmailRetry('messages.list(inbox)', () =>
    gmail.users.messages.list({ userId: 'me', q, maxResults: opts.maxResults ?? 25 }));
  const ids = (list.data.messages ?? []).map(m => m.id!).filter(Boolean);

  const { emails, hadFetchGap } = await hydrateByIds(gmail, ids, 8000);
  const filtered = opts.afterEpochMs ? emails.filter(e => e.internalDate > opts.afterEpochMs!) : emails;
  return { emails: filtered, hadFetchGap };
}

/**
 * Fetch the inbox for one-time INDEXING (not triage): unlike fetchInbox this does NOT filter to
 * is:unread (the seeded/existing inbox has been read), keeps primary-category mail, follows
 * pageToken up to `maxResults`, and hydrates larger bodies. Read-only; never advances any watermark.
 */
export async function fetchInboxForBackfill(
  handle: string,
  opts: { newerThanDays?: number; maxResults?: number } = {},
): Promise<DealEmail[]> {
  const gmail = await getGmailClientForHandle(handle);
  const cap = opts.maxResults ?? 400;
  const q = ['in:inbox', 'category:primary', opts.newerThanDays ? `newer_than:${opts.newerThanDays}d` : '']
    .filter(Boolean).join(' ');
  const ids = await listAllIds(gmail, q, cap, false);
  // Paced hydration: bulk gets cost 20 units each against a 6,000/user/min budget.
  const { emails } = await hydrateByIds(gmail, ids, 20000, { pauseMs: 500 });
  return emails;
}

/**
 * Fetch mail broadly for the SEARCH index backfill: no in:inbox restriction, so sent and
 * archived mail are covered too (spam/trash stay excluded by default; chats excluded
 * explicitly). Paced to respect the per-user quota budget.
 */
export async function fetchAllMailForIndex(
  handle: string,
  opts: { newerThanDays?: number; maxResults?: number } = {},
): Promise<DealEmail[]> {
  const gmail = await getGmailClientForHandle(handle);
  const cap = opts.maxResults ?? Number(process.env.EMAIL_SEARCH_BACKFILL_MAX || 600);
  const q = ['-in:chats', `newer_than:${opts.newerThanDays ?? 730}d`].join(' ');
  const ids = await listAllIds(gmail, q, cap, false);
  const { emails } = await hydrateByIds(gmail, ids, 20000, { pauseMs: 1000 });
  return emails;
}

/** Fetch recent SENT mail for the search index (the INBOX-only watch never pushes these). */
export async function fetchRecentSent(
  handle: string,
  opts: { newerThanDays?: number; maxResults?: number } = {},
): Promise<DealEmail[]> {
  const gmail = await getGmailClientForHandle(handle);
  const q = `in:sent newer_than:${opts.newerThanDays ?? 2}d`;
  const ids = await listAllIds(gmail, q, opts.maxResults ?? 20, false);
  const { emails } = await hydrateByIds(gmail, ids, 20000);
  return emails;
}

/** Page through messages.list collecting ids up to `cap`. */
async function listAllIds(gmail: gmail_v1.Gmail, q: string, cap: number, includeSpamTrash: boolean): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await withGmailRetry('messages.list(page)', () =>
      gmail.users.messages.list({
        userId: 'me', q,
        maxResults: Math.min(100, cap - ids.length),
        pageToken,
        includeSpamTrash: includeSpamTrash || undefined,
      }));
    for (const m of list.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < cap);
  return ids;
}

export interface WatchResult {
  emailAddress: string | null;
  historyId: string | null;
  expiration: string | null; // epoch ms as string (Gmail's format)
}

/**
 * Subscribe the agent's INBOX to Gmail push notifications via Cloud Pub/Sub. Returns the
 * authorized email address (for push -> handle mapping) and the current historyId/expiration
 * so the caller can persist them. users.watch needs only the gmail.readonly scope we already
 * hold. The watch lapses in <=7 days, so a renewal cron must re-call this.
 */
export async function watchMailbox(handle: string, topicName: string): Promise<WatchResult> {
  const gmail = await getGmailClientForHandle(handle);
  const profile = await withGmailRetry('getProfile', () => gmail.users.getProfile({ userId: 'me' }));
  const watch = await withGmailRetry('watch', () => gmail.users.watch({
    userId: 'me',
    requestBody: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' },
  }));
  return {
    emailAddress: profile.data.emailAddress ?? null,
    historyId: watch.data.historyId ? String(watch.data.historyId) : (profile.data.historyId ? String(profile.data.historyId) : null),
    expiration: watch.data.expiration ? String(watch.data.expiration) : null,
  };
}

/** Stop push notifications for a handle (best-effort; used on disconnect/revoke + watchdog resets). */
export async function stopWatch(handle: string): Promise<void> {
  const gmail = await getGmailClientForHandle(handle);
  await withGmailRetry('stop', () => gmail.users.stop({ userId: 'me' }));
}

export interface HistoryResult {
  messageIds: string[];   // INBOX messages added since startHistoryId, de-duplicated
  newHistoryId: string | null;
  // True when maxIds stopped the listing early. newHistoryId then points at the LAST CONSUMED
  // history record (not the mailbox head), so committing it resumes exactly after this chunk —
  // a mail storm drains in bounded, non-repeating chunks across runs.
  truncated: boolean;
}

/**
 * List INBOX messages added since `startHistoryId` (the incremental push sync). Throws if the
 * history id is too old (Gmail 404s) so the caller can fall back to a watermark sync.
 */
export async function listNewMessageIds(handle: string, startHistoryId: string, maxIds = Number(process.env.JUDGE_RUN_MAX || 50)): Promise<HistoryResult> {
  const gmail = await getGmailClientForHandle(handle);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId: string | null = null;
  // The historyId of the last FULLY consumed history record — the safe resume point if maxIds
  // stops the listing early. Without the cap, one run would judge an entire mail storm (one
  // judge call per email, thousands in a burst); with it, each run drains a bounded chunk and
  // commits a cursor that resumes after that chunk.
  let lastConsumedRecordId: string | null = null;
  let truncated = false;

  outer:
  do {
    const res = await withGmailRetry('history.list', () => gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      pageToken,
      maxResults: 100,
    }));
    if (res.data.historyId) newHistoryId = String(res.data.historyId);
    for (const h of res.data.history ?? []) {
      // Cap check BETWEEN records: never consume half a record, so the resume cursor is exact.
      if (maxIds > 0 && ids.size >= maxIds) { truncated = true; break outer; }
      if (h.id) lastConsumedRecordId = String(h.id);
      for (const added of h.messagesAdded ?? []) {
        const m = added.message;
        const labels = m?.labelIds ?? [];
        // Match the watermark-scan path's `category:primary`: only genuinely-new PRIMARY inbox
        // mail. Skip drafts/sent/trash/spam and Gmail's Promotions/Social/Forums tabs, so the
        // push path and the fallback judge the same set (and we don't burn the Judge on promos).
        const excluded = ['DRAFT', 'SENT', 'TRASH', 'SPAM', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
        if (m?.id && labels.includes('INBOX') && !excluded.some(l => labels.includes(l))) {
          ids.add(m.id);
        }
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    messageIds: [...ids],
    newHistoryId: truncated ? (lastConsumedRecordId ?? startHistoryId) : newHistoryId,
    truncated,
  };
}

/** Fetch one message by id with the full body (the read-email path for the Ops agent). */
export async function fetchMessageById(handle: string, messageId: string): Promise<DealEmail | null> {
  const gmail = await getGmailClientForHandle(handle);
  const res = await withGmailRetry(`messages.get(${messageId})`, () =>
    gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })).catch(() => null);
  if (!res?.data?.id) return null;
  return messageToDealEmail(res.data, 20000);
}

/**
 * Fetch a whole thread in order (every message, full-ish bodies) for timeline/response questions.
 * Per-message body budget scales with thread length: a 3-message thread gets ~8k chars each, a
 * 20-message thread ~2.5k — so short threads aren't clipped and long ones don't blow the context.
 */
export async function fetchThread(handle: string, threadId: string): Promise<DealEmail[]> {
  const gmail = await getGmailClientForHandle(handle);
  const res = await withGmailRetry(`threads.get(${threadId})`, () =>
    gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
  const raw = (res.data.messages ?? []).filter((m): m is gmail_v1.Schema$Message => !!m?.id);
  const perMessage = Math.min(8000, Math.max(2500, Math.floor(36000 / Math.max(1, raw.length))));
  return raw.map(m => messageToDealEmail(m, perMessage)).sort((a, b) => a.internalDate - b.internalDate);
}

export interface FetchByIdsResult {
  emails: DealEmail[];
  // True when at least one id failed to hydrate for a TRANSIENT reason. The caller must not
  // advance its history cursor past this batch, or the missed message is skipped forever.
  hadFetchGap: boolean;
}

/** Fetch full messages by id and hydrate them into DealEmails (bounded concurrency). */
export async function fetchMessagesByIds(handle: string, ids: string[]): Promise<FetchByIdsResult> {
  if (!ids.length) return { emails: [], hadFetchGap: false };
  const gmail = await getGmailClientForHandle(handle);
  return hydrateByIds(gmail, ids, 8000);
}

export async function getAttachment(handle: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = await getGmailClientForHandle(handle);
  const res = await withGmailRetry('attachments.get', () =>
    gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }));
  return Buffer.from(res.data.data ?? '', 'base64url');
}

// --- bundled research reference (read by the Ops agent before searching) ------
// A .txt shipped by the build's src/**/*.txt copy
// step, sliceable by `## / ### <section>` heading so the model pulls only what it needs.
let gmailDocsCache: string | null = null;

/** Return the bundled Gmail research reference, or a single `## / ### <section>` slice. */
export function getGmailDocs(section?: string): string {
  if (gmailDocsCache === null) {
    const path = process.env.GMAIL_DOCS_PATH || join(__dirname, 'gmail.llms-full.txt');
    try {
      gmailDocsCache = readFileSync(path, 'utf8').trim();
      if (!gmailDocsCache) throw new Error('empty');
    } catch {
      throw new Error(`[gmail] Missing research reference at ${path}. Did the build copy step run (npm run build copies src/**/*.txt into dist)?`);
    }
  }
  if (!section) return gmailDocsCache;

  const lines = gmailDocsCache.split('\n');
  const wanted = section.trim().toLowerCase();
  let start = -1;
  let startLevel = 2;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(.*)$/);
    if (m && m[2].trim().toLowerCase() === wanted) { start = i; startLevel = m[1].length; break; }
  }
  if (start === -1) {
    return `Section "${section}" not found. Call gmail_docs with no section for the full reference. Top-level sections include: Tools, Search Operators, Recipes, Limits.`;
  }
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= startLevel) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/** Most-recent message date for a client (for "when did I last email X"). */
export async function lastContactDate(handle: string, clientNameOrEmail: string): Promise<DealEmail | null> {
  const emails = await findDealEmails(handle, {
    query: clientNameOrEmail.includes('@')
      ? `(from:${clientNameOrEmail} OR to:${clientNameOrEmail})`
      : `"${clientNameOrEmail}"`,
    newerThanDays: 730,
    maxResults: 10,
  });
  if (!emails.length) return null;
  // internalDate is Gmail's own receive timestamp — more reliable than the Date header.
  return emails.sort((a, b) => b.internalDate - a.internalDate)[0];
}
