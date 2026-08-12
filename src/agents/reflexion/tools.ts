// Reflexion's NATIVE tool set (real multi-turn loop like Ops/MM — never toolsViaJson).
// Read tools exist for targeted digging; the seed prompt preloads the common context, so a
// typical run is 1–3 turns of pure writes. Every write handler enforces its invariant IN CODE
// (never-delete, unsafe-text screens, key allowlists, the wake budget) — the Context.md values
// are the first defense, these handlers are the deterministic backstop (charter §10.1).

import type { LlmToolDef } from '../../llm/types.js';
import type { ReflexionTask } from '../types.js';
import { searchMessages } from '../../db/repositories/conversations.js';
import { listShortTerm, type ShortKind, type ShortTermEntry } from '../../db/repositories/memoryShort.js';
import { listMediumActive, listMediumAll, upsertFact, retractEntry, type MediumEntry } from '../../db/repositories/memoryMedium.js';
import { getLongDoc, saveLongDoc, listLongRevisions } from '../../db/repositories/memoryLong.js';
import { getMemory, setPreference } from '../../db/repositories/memory.js';
import { saveSelfPrompt, SELF_PROMPT_MAX_CHARS } from '../../db/repositories/reflexionState.js';
import { createAutomation, countWakesToday, deriveDedupeKey, listAutomations } from '../../db/repositories/automations.js';
import { looksUnsafe } from '../../memory/preferences.js';
import { FACT_KEYS } from '../../memory/mediumTerm.js';
import { scopeHistoryToUser } from '../../memory/transcript.js';
import { record } from '../../diagnostics/trace.js';

export const REFLEXION_WAKE_CAP = Number(process.env.REFLEXION_WAKE_CAP) || 6;
const WAKE_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const LONG_DOC_MAX_CHARS = 12000; // storage-side cap; the render-side cap (wrappers.ts) is 6000

// prefs keys Reflexion may set — the conversational fact slots plus the timezone. Everything
// operational (chat_id, gmail_*, watermarks, pending_* markers) is machinery, never memory.
const PREF_ALLOWLIST = new Set<string>([...FACT_KEYS, 'agent_tz']);

/** Mutable per-run context the handlers thread state through. `writes` counts successful TIER
 *  writes only (it gates the migration marker); self-prompt/wake bookkeeping doesn't count. */
export interface ReflexionRunCtx {
  task: ReflexionTask;
  tz: string;
  writes: number;
  wakes: number;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const REFLEXION_TOOLS: LlmToolDef[] = [
  {
    name: 'search_chat',
    description: 'Keyword-search this user\'s chat history (last 7 days) when the preloaded recent messages aren\'t enough — e.g. to trace when a fact was first mentioned or find the exact wording of a correction.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Substring to search for.' },
        limit: { type: 'integer', description: 'Max messages (default 12).' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'read_short_term',
    description: 'List short-term memory entries (research delivered, files read, emails flagged) beyond the preloaded 24h slice — e.g. a wider window after a missed daily pass.',
    inputSchema: {
      type: 'object',
      properties: {
        since_hours: { type: 'integer', description: 'Look-back window in hours (default 24, max 72 — older rows are swept).' },
        kind: { type: 'string', enum: ['ops_research', 'media_analysis', 'email_flag'], description: 'Filter to one kind.' },
      },
    },
  },
  {
    name: 'read_medium_term',
    description: 'List medium-term rows WITH their ids and status — the view you need before retiring a duplicate or checking lineage.',
    inputSchema: {
      type: 'object',
      properties: {
        include_inactive: { type: 'boolean', description: 'Also show superseded/retracted rows (lineage view). Default false.' },
      },
    },
  },
  {
    name: 'read_long_term',
    description: 'Read the current long-term doc with its version number (you need the version to rewrite it), optionally with recent revision metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        include_revisions: { type: 'boolean', description: 'Also list recent revision metadata (version, author, when). Default false.' },
      },
    },
  },
  {
    name: 'read_legacy_memory',
    description: 'Read the LEGACY memory row (old dossier markdown + prefs arrays) for the first-run migration. Read-only — the system retires the legacy store separately.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_wakes',
    description: 'Your wake ledger for today: scheduled self-wakes and remaining budget.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'upsert_medium_fact',
    description: 'Set a durable medium-term fact slot (snake_case key → value). Supersedes the previous value of the same key atomically; unchanged values are a no-op. Use the canonical slots when they fit (comms_style, address_as) and descriptive new slots for other durable atoms (e.g. "location", "occupation", "current_project"). Facts describe THEIR world — never the assistant.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'snake_case slot name.' },
        value: { type: 'string', description: 'The fact, phrased as they\'d recognize it.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'retire_medium_entry',
    description: 'Soft-retire one medium row by id (duplicate, contradicted, or no longer true). The row is preserved with a retracted status — nothing is ever deleted. To REPLACE a fact, use upsert_medium_fact instead (it supersedes atomically).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The row id from read_medium_term.' },
        reason: { type: 'string', description: 'Why (goes to the changelog).' },
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'rewrite_long_term',
    description: 'Replace the long-term markdown doc (the one readable briefing: who they are, how they work, their world — projects, arcs, rules, running jokes — and how Irises should be with them). The previous version is snapshotted automatically — but you still MERGE, never drop unresolved material. Pass the version you read (read_long_term).',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'The full new doc. Short headed sections; under ~1500 words.' },
        expected_version: { type: 'integer', description: 'The version you read. A stale version is rejected — re-read and re-merge.' },
        change_note: { type: 'string', description: 'One line: what changed. An empty markdown is rejected unless this starts with "INTENTIONAL WIPE:".' },
      },
      required: ['markdown', 'expected_version', 'change_note'],
    },
  },
  {
    name: 'set_structured_pref',
    description: 'Set one allowlisted structured preference: comms_style, address_as, or agent_tz (IANA timezone like "America/Denver" — set it whenever their timezone/location surfaces; it anchors their daily rhythm).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'One of: comms_style, address_as, agent_tz.' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'schedule_wake',
    description: 'Schedule ONE future self-wake (a focused curation run at a specific time). Default is NO wake — the daily pass handles routine work; use this only for a genuinely time-boxed reason. Hard budget enforced.',
    inputSchema: {
      type: 'object',
      properties: {
        fire_at: { type: 'string', description: 'Absolute ISO 8601 instant (UTC), within the next 7 days.' },
        reason: { type: 'string', description: 'What this wake must reconcile — it becomes your focus brief when it fires.' },
      },
      required: ['fire_at', 'reason'],
    },
  },
  {
    name: 'update_self_prompt',
    description: 'Rewrite your own advisory self-prompt (focus areas, patterns noticed, threads to watch). Under a page; it never overrides your values; user facts belong in the tiers, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        change_note: { type: 'string', description: 'One line: why.' },
      },
      required: ['markdown', 'change_note'],
    },
  },
];

// ── Formatting helpers (shared with the seed prompt in client.ts) ────────────

export function formatMediumRows(rows: MediumEntry[]): string {
  if (!rows.length) return '(no medium-term rows)';
  return rows.map(r => {
    const slot = r.key ? ` key=${r.key}` : '';
    const lineage = r.supersededBy ? ` → superseded by ${r.supersededBy}` : '';
    // Date each row so the curator can see "have I already recorded this, and when?" — the one
    // genuinely undated block in the seed (chat/short-term all carry their own stamps).
    const when = ` @ ${new Date(r.updatedAt).toISOString().slice(0, 10)}`;
    return `[${r.id}] (${r.kind}/${r.status}${slot}${when}) ${r.body}${lineage}`;
  }).join('\n');
}

export function formatShortEntries(entries: ShortTermEntry[]): string {
  if (!entries.length) return '(no short-term entries)';
  return entries.map(e => {
    const when = new Date(e.createdAt).toISOString();
    const asked = e.request ? ` — they asked "${e.request}"` : '';
    return `[${e.kind} @ ${when}]${asked}\n${e.content.slice(0, 700)}`;
  }).join('\n\n');
}

function isValidIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function longDocSectionsUnsafe(md: string): string | null {
  for (const section of md.split(/\n(?=#{1,6}\s)/)) {
    const bad = looksUnsafe(section);
    if (bad) return bad;
  }
  return null;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Run one tool call; always returns a result STRING to feed back into the loop (errors are
 *  described, never thrown — the model must be able to react and continue). */
export async function dispatchReflexionTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ReflexionRunCtx,
): Promise<string> {
  const handle = ctx.task.agentHandle;
  try {
    switch (name) {
      case 'search_chat': {
        const keyword = String(input.keyword ?? '').trim();
        if (!keyword) return 'search_chat: keyword required';
        const limit = Math.min(Number(input.limit) || 12, 25);
        const hits = await searchMessages(ctx.task.chatId, keyword, limit);
        // Same scoping as the seed transcript: this run writes under `handle`, so it may only
        // read that user's lines (group pseudo-handles pass through, with lines labeled).
        const scoped = scopeHistoryToUser(hits, handle);
        if (!scoped.length) {
          return hits.length
            ? `no messages from this user matching "${keyword}" in the last 7 days (matches from other participants are not this user's memory)`
            : `no messages matching "${keyword}" in the last 7 days`;
        }
        return scoped.map(m => `[${m.at ? new Date(m.at).toISOString() : '?'}] ${m.role === 'user' ? `user (${m.handle ?? handle})` : m.role}: ${m.content.slice(0, 400)}`).join('\n');
      }

      case 'read_short_term': {
        const hours = Math.min(Number(input.since_hours) || 24, 72);
        const kinds = input.kind ? [String(input.kind) as ShortKind] : undefined;
        const entries = await listShortTerm(handle, { sinceMs: Date.now() - hours * 60 * 60 * 1000, kinds, limit: 50 });
        return formatShortEntries(entries);
      }

      case 'read_medium_term': {
        const rows = input.include_inactive === true ? await listMediumAll(handle) : await listMediumActive(handle);
        return formatMediumRows(rows);
      }

      case 'read_long_term': {
        const doc = await getLongDoc(handle);
        let out = doc
          ? `version: ${doc.version}\n---\n${doc.docMd || '(empty doc)'}`
          : 'no long-term doc yet (version 0 — pass expected_version 0 to create it)';
        if (input.include_revisions === true) {
          const revs = await listLongRevisions(handle, 10);
          out += `\n---\nrevisions: ${revs.map(r => `v${r.version} by ${r.writtenBy} @ ${new Date(r.createdAt).toISOString()}`).join('; ') || '(none)'}`;
        }
        return out;
      }

      case 'read_legacy_memory': {
        const memory = await getMemory(handle);
        if (!memory) return 'no legacy memory row';
        const directives = Array.isArray(memory.prefs.directives) ? memory.prefs.directives : [];
        const notes = Array.isArray(memory.prefs.important_notes) ? memory.prefs.important_notes : [];
        return [
          `LEGACY DOSSIER:\n${memory.dossierMd || '(empty)'}`,
          `LEGACY DIRECTIVES (already backfilled as medium rows — verify, don't duplicate):\n${JSON.stringify(directives)}`,
          `LEGACY NOTES (already backfilled as medium rows — verify, don't duplicate):\n${JSON.stringify(notes)}`,
        ].join('\n\n');
      }

      case 'list_wakes': {
        const used = await countWakesToday(handle, ctx.tz);
        const all = await listAutomations(handle);
        const wakes = all.filter(a => a.source === 'reflexion' && a.scheduleKind === 'once' && a.status === 'active');
        const lines = wakes.map(w => `- ${w.nextRunAt}: ${w.instruction}`).join('\n') || '(none scheduled)';
        return `wakes created today (any status): ${used}/${REFLEXION_WAKE_CAP}\nactive upcoming wakes:\n${lines}`;
      }

      case 'upsert_medium_fact': {
        const key = String(input.key ?? '').trim().toLowerCase();
        const value = String(input.value ?? '').trim();
        if (!/^[a-z][a-z0-9_]{1,48}$/.test(key)) return `upsert_medium_fact: "${key}" is not a valid snake_case slot name`;
        if (/^(chat_id|gmail_|email_|recent_|pending_|surfaced_|directives$|important_notes$|respect_quiet_hours$|agent_tz$)/.test(key)) {
          return `upsert_medium_fact: "${key}" is operational machinery, not memory${key === 'agent_tz' ? ' — use set_structured_pref for agent_tz' : ''} — refused`;
        }
        if (!value) return 'upsert_medium_fact: empty value — to remove a fact, retire its row instead';
        const bad = looksUnsafe(value);
        if (bad) return `upsert_medium_fact: refused — the value reads like ${bad}; record what HAPPENED as a plain fact instead`;
        await upsertFact(handle, key, value, 'reflexion');
        // Structured FACT_KEYS dual-write to legacy prefs, exactly like set_structured_pref and
        // Convo's set_preference routing: during the soak window the addressing/fact renderers
        // read prefs-first, so a medium-only write would silently never render.
        if (FACT_KEYS.has(key)) await setPreference(handle, key, value);
        ctx.writes++;
        return `fact "${key}" set`;
      }

      case 'retire_medium_entry': {
        const id = String(input.id ?? '').trim();
        if (!id) return 'retire_medium_entry: id required';
        const ok = await retractEntry(handle, id);
        if (ok) ctx.writes++;
        return ok ? `row ${id} retired (preserved, no longer active)` : `row ${id} not found active — already retired or never existed`;
      }

      case 'rewrite_long_term': {
        const markdown = String(input.markdown ?? '').trim();
        const changeNote = String(input.change_note ?? '').trim();
        const expected = Number(input.expected_version);
        if (!Number.isInteger(expected) || expected < 0) return 'rewrite_long_term: expected_version must be the integer version you read';
        if (!markdown && !changeNote.startsWith('INTENTIONAL WIPE:')) {
          return 'rewrite_long_term: refused — an empty doc erases the briefing. If you truly mean to wipe it, start change_note with "INTENTIONAL WIPE:".';
        }
        if (markdown.length > LONG_DOC_MAX_CHARS) {
          return `rewrite_long_term: refused — ${markdown.length} chars is over the ${LONG_DOC_MAX_CHARS} cap. Tighten it: this is a briefing, not a log.`;
        }
        const bad = longDocSectionsUnsafe(markdown);
        if (bad) return `rewrite_long_term: refused — a section reads like ${bad}. Describe the person, never instructions to an assistant.`;
        const saved = await saveLongDoc(handle, markdown, expected, 'reflexion');
        if (saved == null) return 'rewrite_long_term: version conflict — someone wrote since you read. Call read_long_term again and re-merge.';
        ctx.writes++;
        return `long-term doc saved as version ${saved} (${changeNote})`;
      }

      case 'set_structured_pref': {
        const key = String(input.key ?? '').trim().toLowerCase();
        const value = String(input.value ?? '').trim();
        if (!PREF_ALLOWLIST.has(key)) return `set_structured_pref: "${key}" is not an allowlisted slot`;
        if (!value) return 'set_structured_pref: empty value — refused';
        if (key === 'agent_tz' && !isValidIana(value)) return `set_structured_pref: "${value}" is not a valid IANA timezone`;
        const bad = looksUnsafe(value);
        if (bad) return `set_structured_pref: refused — the value reads like ${bad}`;
        // Same dual-write as Convo's set_preference fact routing (soak window): prefs stays the
        // legacy-readable copy, the medium row is the tier truth. agent_tz is prefs-only.
        if (FACT_KEYS.has(key)) {
          await upsertFact(handle, key, value, 'reflexion');
        }
        await setPreference(handle, key, value);
        ctx.writes++;
        return `preference "${key}" set`;
      }

      case 'schedule_wake': {
        const reason = String(input.reason ?? '').trim();
        const fireAtMs = Date.parse(String(input.fire_at ?? ''));
        if (!reason) return 'schedule_wake: reason required — it becomes your focus brief when the wake fires';
        if (!Number.isFinite(fireAtMs)) return 'schedule_wake: fire_at must be an absolute ISO 8601 instant';
        if (fireAtMs <= Date.now()) return 'schedule_wake: fire_at is in the past — refused';
        if (fireAtMs > Date.now() + WAKE_MAX_AHEAD_MS) return 'schedule_wake: beyond 7 days out — fold it into a daily pass instead';
        const used = await countWakesToday(handle, ctx.tz);
        if (used >= REFLEXION_WAKE_CAP) {
          return `wake budget exhausted for today (${used}/${REFLEXION_WAKE_CAP} used) — fold this into tomorrow's daily pass instead`;
        }
        // 15-minute rounding on the dedupe key: a retried near-identical wake is ONE row.
        const rounded = new Date(Math.round(fireAtMs / (15 * 60 * 1000)) * 15 * 60 * 1000).toISOString();
        const created = await createAutomation({
          agentHandle: handle, chatId: ctx.task.chatId, source: 'reflexion',
          title: 'reflexion self-wake', instruction: reason,
          scheduleKind: 'once', nextRunAt: new Date(fireAtMs).toISOString(),
          respectQuietHours: false, needsOps: false,
          dedupeKey: deriveDedupeKey('reflexion-wake', reason, rounded),
        });
        if (!created) return 'schedule_wake: the scheduler write failed — do NOT retry this run; the daily pass covers it';
        ctx.wakes++;
        record({ type: 'event', chatId: ctx.task.chatId, handle, taskId: ctx.task.id, label: 'reflexion:wake_scheduled', detail: { fireAt: created.nextRunAt, reason } });
        return `wake scheduled for ${created.nextRunAt} (${used + 1}/${REFLEXION_WAKE_CAP} today)`;
      }

      case 'update_self_prompt': {
        const markdown = String(input.markdown ?? '').trim();
        const changeNote = String(input.change_note ?? '').trim() || 'no note';
        if (markdown.length > SELF_PROMPT_MAX_CHARS) {
          return `update_self_prompt: refused — ${markdown.length} chars is over the ${SELF_PROMPT_MAX_CHARS} cap; keep it under a page`;
        }
        await saveSelfPrompt(handle, markdown, changeNote);
        return 'self-prompt updated';
      }

      default:
        return `unknown tool: ${name}`;
    }
  } catch (err) {
    console.error(`[reflexion] tool ${name} failed`, err);
    return `${name} failed: ${err instanceof Error ? err.message : 'unknown error'} — decide whether to continue without it`;
  }
}
