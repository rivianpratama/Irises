// Read-only cross-user memory-leak diagnostic + contamination audit.
//
//   npx tsx scripts/diagnose-memory-leak.ts [--handles +1555...,+1555...] [--value "Chief"] [--csv report.csv] [--days 30]
//
// Two jobs, ZERO writes:
//   A. Determine the leak MECHANISM from production data: which tier carries the leaked
//      value for the victim (each tier implicates a different writer), whether any chat
//      ever carried two users' handles (shared-thread detector), whether remember_user
//      ever fired with a non-null cross handle (diagnostic_turn_history, ~30d retention),
//      and whether Reflexion authored the contaminated rows (written_by / source lineage).
//   B. Contamination inventory for MANUAL cleanup: every addressing value cross-checked
//      against who actually said it in chat history. No auto-delete — this script only reads.
//
// Requires Supabase (the leak evidence lives in the shared store); exits on memory backend.
import 'dotenv/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const esc = (s: string) => s.replace(/[%_]/g, '\\$&');
const short = (s: unknown, n = 60) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

interface Suspect {
  handle: string;
  source: 'profile.name' | 'prefs.address_as' | 'medium.address_as' | 'prefs.directive' | 'medium.directive';
  value: string;
  when?: string;
  meta?: string; // status/source lineage for medium rows
}

interface EvidenceRow extends Suspect {
  selfCount: number;
  foreignHandles: string[];
  verdict: 'SELF_STATED' | 'LIKELY_CONTAMINATED' | 'UNVERIFIABLE';
}

async function main() {
  const { getSupabase } = await import('../src/db/client.js');
  const supabase = getSupabase();
  if (!supabase) {
    console.error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). This diagnostic reads the shared store and cannot run on the memory backend.');
    process.exit(1);
  }

  const focusHandles = (arg('handles') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const knownValue = arg('value')?.trim();
  const historyDays = Number(arg('days') ?? 30);
  const csvPath = arg('csv');
  const sinceIso = new Date(Date.now() - historyDays * 24 * 3600_000).toISOString();

  // Page a table fully (supabase-js caps a single request at 1000 rows). `build` must
  // return a FRESH builder each call — builders are single-use.
  async function pageAll<T>(build: () => any, cap = 50_000): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; from < cap; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...(data ?? []));
      if (!data || data.length < 1000) return out;
    }
    console.warn(`  ⚠ paging cap ${cap} hit — results beyond it not scanned`);
    return out;
  }

  console.log('════════════════════════════════════════════════════════════════');
  console.log(' Irises cross-user memory-leak diagnostic (read-only)');
  console.log('════════════════════════════════════════════════════════════════\n');

  // ── 1. Roster + handle distinctness ────────────────────────────────────────
  const profiles = await pageAll<{ handle: string; name: string | null; facts: string[] | null; last_seen: string | null }>(
    () => supabase.from('user_profiles').select('handle, name, facts, last_seen'));
  const memories = await pageAll<{ handle: string; dossier_md: string | null; prefs: Record<string, unknown> | null; updated_at: string | null }>(
    () => supabase.from('agent_memory').select('handle, dossier_md, prefs, updated_at'));

  const allHandles = [...new Set([...profiles.map(p => p.handle), ...memories.map(m => m.handle)])];
  const realHandles = allHandles.filter(h => !h.startsWith('group:'));
  console.log(`§1 Roster: ${profiles.length} user_profiles, ${memories.length} agent_memory rows, ${realHandles.length} distinct user handles.`);

  const lowerDupes = new Map<string, string[]>();
  for (const h of realHandles) {
    const k = h.toLowerCase();
    lowerDupes.set(k, [...(lowerDupes.get(k) ?? []), h]);
  }
  const caseDupes = [...lowerDupes.values()].filter(v => v.length > 1);
  const digitTail = new Map<string, string[]>();
  for (const h of realHandles) {
    const d = h.replace(/\D/g, '').slice(-10);
    if (d.length >= 7) digitTail.set(d, [...(digitTail.get(d) ?? []), h]);
  }
  const formatDupes = [...digitTail.values()].filter(v => new Set(v).size > 1);
  if (caseDupes.length) console.log(`  ⚠ CASE-VARIANT handle duplicates (same identity, split rows): ${JSON.stringify(caseDupes)}`);
  if (formatDupes.length) console.log(`  ⚠ FORMAT-VARIANT handle duplicates (same last-10 digits, different strings): ${JSON.stringify(formatDupes)}`);
  if (!caseDupes.length && !formatDupes.length) console.log('  ✓ All handles byte-distinct (no case/format variants).');

  // ── 2. Suspect value inventory ──────────────────────────────────────────────
  const medium = await pageAll<{ agent_handle: string; kind: string; key: string | null; body: string; status: string; source: string | null; created_at: string | null }>(
    () => supabase.from('memory_medium').select('agent_handle, kind, key, body, status, source, created_at'));
  const longDocs = await pageAll<{ agent_handle: string; doc_md: string | null; version: number }>(
    () => supabase.from('memory_long').select('agent_handle, doc_md, version'));

  const suspects: Suspect[] = [];
  for (const p of profiles) {
    if (p.name?.trim()) suspects.push({ handle: p.handle, source: 'profile.name', value: p.name.trim(), when: p.last_seen ?? undefined, meta: 'last_seen≈write recency' });
  }
  for (const m of memories) {
    const aa = m.prefs?.address_as;
    if (typeof aa === 'string' && aa.trim()) suspects.push({ handle: m.handle, source: 'prefs.address_as', value: aa.trim(), when: m.updated_at ?? undefined });
    const dirs = m.prefs?.directives;
    if (Array.isArray(dirs)) {
      for (const d of dirs) {
        if (d && typeof (d as { text?: string }).text === 'string') {
          suspects.push({ handle: m.handle, source: 'prefs.directive', value: (d as { text: string }).text.trim(), when: m.updated_at ?? undefined });
        }
      }
    }
  }
  for (const r of medium) {
    if (r.kind === 'fact' && r.key === 'address_as' && r.body?.trim()) {
      suspects.push({ handle: r.agent_handle, source: 'medium.address_as', value: r.body.trim(), when: r.created_at ?? undefined, meta: `status=${r.status} source=${r.source ?? '?'}` });
    }
    if (r.kind === 'directive' && r.status === 'active' && r.body?.trim()) {
      suspects.push({ handle: r.agent_handle, source: 'medium.directive', value: r.body.trim(), when: r.created_at ?? undefined, meta: `source=${r.source ?? '?'}` });
    }
  }
  const addressing = suspects.filter(s => s.source !== 'prefs.directive' && s.source !== 'medium.directive');
  console.log(`\n§2 Inventory: ${addressing.length} addressing values (name/address_as), ${suspects.length - addressing.length} directives.`);
  for (const s of addressing) console.log(`  ${s.handle}  [${s.source}]  "${short(s.value, 40)}"${s.meta ? `  (${s.meta})` : ''}${s.when ? `  @${s.when.slice(0, 10)}` : ''}`);

  // ── 3. Cross-user value collisions ─────────────────────────────────────────
  const byValue = new Map<string, Suspect[]>();
  for (const s of addressing) byValue.set(s.value.toLowerCase(), [...(byValue.get(s.value.toLowerCase()) ?? []), s]);
  const collisions = [...byValue.values()].filter(g => new Set(g.map(s => s.handle)).size > 1);
  console.log(`\n§3 Cross-user addressing collisions: ${collisions.length}`);
  for (const g of collisions) {
    console.log(`  ⚠ "${short(g[0].value, 40)}" appears on ${new Set(g.map(s => s.handle)).size} handles: ${g.map(s => `${s.handle}[${s.source}]`).join(', ')}`);
  }

  // ── 4. Shared-thread detector ──────────────────────────────────────────────
  const msgHandles = await pageAll<{ chat_id: string; handle: string }>(
    () => supabase.from('messages').select('chat_id, handle').not('handle', 'is', null), 200_000);
  const chatParticipants = new Map<string, Set<string>>();
  for (const m of msgHandles) {
    const set = chatParticipants.get(m.chat_id) ?? new Set<string>();
    set.add(m.handle);
    chatParticipants.set(m.chat_id, set);
  }
  const sharedThreads = [...chatParticipants.entries()].filter(([, s]) => s.size > 1);
  console.log(`\n§4 Shared-thread detector: ${chatParticipants.size} chats with attributed user messages (7-day message retention limits visibility).`);
  if (sharedThreads.length) {
    console.log(`  ⚠ ${sharedThreads.length} chat(s) carry MESSAGES FROM MULTIPLE USER HANDLES — the dossier/Reflexion harvest vector is live in these:`);
    for (const [chatId, set] of sharedThreads) console.log(`    chat ${chatId}: ${[...set].join(', ')}`);
  } else {
    console.log('  ✓ No chat in the retained window carries two user handles. (Older shared threads may have aged out.)');
  }
  const chatIdOwners = new Map<string, string[]>();
  for (const m of memories) {
    const cid = m.prefs?.chat_id;
    if (typeof cid === 'string' && cid) chatIdOwners.set(cid, [...(chatIdOwners.get(cid) ?? []), m.handle]);
  }
  const sharedChatIdPrefs = [...chatIdOwners.entries()].filter(([, hs]) => hs.length > 1);
  for (const [cid, hs] of sharedChatIdPrefs) console.log(`  ⚠ prefs.chat_id ${cid} is the proactive-send target of MULTIPLE handles: ${hs.join(', ')}`);
  for (const [cid, hs] of chatIdOwners) {
    const parts = chatParticipants.get(cid);
    if (parts && [...parts].some(p => !hs.includes(p))) {
      console.log(`  ⚠ prefs.chat_id ${cid} (owner ${hs.join('/')}) has messages from other handle(s): ${[...parts].filter(p => !hs.includes(p)).join(', ')} — Reflexion/emailJudge reads of it cross users`);
    }
  }

  // ── 5. Per-value chat evidence → contamination verdicts ────────────────────
  console.log('\n§5 Evidence pass (who actually said each addressing value in retained history):');
  const evidence: EvidenceRow[] = [];
  for (const s of addressing) {
    if (s.value.length < 3) continue;
    const pat = `%${esc(s.value)}%`;
    const selfRows = await pageAll<{ chat_id: string }>(
      () => supabase.from('messages').select('chat_id').eq('handle', s.handle).eq('role', 'user').ilike('content', pat), 5_000);
    const ownChats = [...new Set(msgHandles.filter(m => m.handle === s.handle).map(m => m.chat_id))];
    let foreign: string[] = [];
    if (ownChats.length) {
      const foreignRows = await pageAll<{ handle: string }>(
        () => supabase.from('messages').select('handle').in('chat_id', ownChats).eq('role', 'user').not('handle', 'is', null).neq('handle', s.handle).ilike('content', pat), 5_000);
      foreign = [...new Set(foreignRows.map(r => r.handle))];
    }
    // Also: did ANY other user say this value anywhere (covers contamination via paths that
    // don't require a shared chat, e.g. remember_user)?
    const anyoneRows = await pageAll<{ handle: string }>(
      () => supabase.from('messages').select('handle').eq('role', 'user').not('handle', 'is', null).neq('handle', s.handle).ilike('content', pat), 5_000);
    const saidByOthers = [...new Set(anyoneRows.map(r => r.handle))];
    const verdict: EvidenceRow['verdict'] = selfRows.length > 0 ? 'SELF_STATED'
      : (foreign.length || saidByOthers.length) ? 'LIKELY_CONTAMINATED' : 'UNVERIFIABLE';
    evidence.push({ ...s, selfCount: selfRows.length, foreignHandles: foreign.length ? foreign : saidByOthers, verdict });
    const mark = verdict === 'SELF_STATED' ? '✓' : verdict === 'LIKELY_CONTAMINATED' ? '⚠' : '?';
    console.log(`  ${mark} ${s.handle} [${s.source}] "${short(s.value, 32)}" → ${verdict}` +
      (verdict !== 'SELF_STATED' && evidence[evidence.length - 1].foreignHandles.length
        ? ` (said by: ${evidence[evidence.length - 1].foreignHandles.join(', ')})` : ''));
  }

  // ── 6. Dossier / long-doc cross-contamination scan ─────────────────────────
  console.log('\n§6 Dossier & long-doc scan (other users\' addressing values inside a doc):');
  const docHits: string[] = [];
  const docs: { handle: string; kind: string; text: string }[] = [
    ...memories.filter(m => m.dossier_md?.trim()).map(m => ({ handle: m.handle, kind: 'dossier_md', text: m.dossier_md as string })),
    ...longDocs.filter(l => l.doc_md?.trim()).map(l => ({ handle: l.agent_handle, kind: 'memory_long', text: l.doc_md as string })),
  ];
  const values = knownValue ? [...addressing, { handle: '(cli --value)', source: 'profile.name' as const, value: knownValue }] : addressing;
  for (const doc of docs) {
    const lower = doc.text.toLowerCase();
    for (const s of values) {
      if (s.handle === doc.handle || s.value.length < 3) continue;
      if (lower.includes(s.value.toLowerCase())) {
        const line = `  ⚠ ${doc.handle}'s ${doc.kind} contains "${short(s.value, 32)}" (an addressing value of ${s.handle})`;
        if (!docHits.includes(line)) { docHits.push(line); console.log(line); }
      }
    }
  }
  if (!docHits.length) console.log('  ✓ No cross-user addressing value found inside any dossier/long doc.');

  // ── 7. remember_user cross-write evidence (diagnostic_turn_history) ───────
  console.log(`\n§7 remember_user evidence (diagnostic_turn_history, last ${historyDays}d):`);
  let crossWrites = 0, turnsScanned = 0, rememberCalls = 0;
  try {
    const turns = await pageAll<{ handle: string | null; chat_id: string | null; last_at: string; turn: { events?: { toolCalls?: { name: string; input?: Record<string, unknown> }[]; label?: string }[] } }>(
      () => supabase.from('diagnostic_turn_history').select('handle, chat_id, last_at, turn').gt('last_at', sinceIso).order('last_at', { ascending: false }), 5_000);
    turnsScanned = turns.length;
    for (const t of turns) {
      for (const ev of t.turn?.events ?? []) {
        for (const tc of ev.toolCalls ?? []) {
          if (tc.name !== 'remember_user') continue;
          rememberCalls++;
          const target = tc.input?.handle;
          if (typeof target === 'string' && target && target !== t.handle) {
            crossWrites++;
            console.log(`  ⚠ CROSS-WRITE: turn of ${t.handle ?? '?'} (chat ${t.chat_id ?? '?'}, ${t.last_at}) called remember_user{handle:"${target}", name:"${short(tc.input?.name, 24)}", fact:"${short(tc.input?.fact, 32)}"}`);
          }
        }
      }
    }
    console.log(`  scanned ${turnsScanned} turns · ${rememberCalls} remember_user call(s) · ${crossWrites} cross-handle write(s)${crossWrites ? '' : ' ✓'}`);
  } catch (err) {
    console.log(`  ? diagnostic_turn_history not readable (${String((err as Error).message).slice(0, 80)}) — mechanism check §7 inconclusive`);
  }

  // ── 8. Reflexion lineage for contaminated rows ─────────────────────────────
  console.log('\n§8 Write lineage:');
  try {
    const revs = await pageAll<{ agent_handle: string; version: number; written_by: string | null; created_at: string | null }>(
      () => supabase.from('memory_long_revisions').select('agent_handle, version, written_by, created_at').order('created_at', { ascending: false }), 2_000);
    const byWriter = new Map<string, number>();
    for (const r of revs) byWriter.set(r.written_by ?? '?', (byWriter.get(r.written_by ?? '?') ?? 0) + 1);
    console.log(`  memory_long_revisions writers: ${[...byWriter.entries()].map(([w, n]) => `${w}×${n}`).join(', ') || '(none)'}`);
  } catch { console.log('  ? memory_long_revisions not readable'); }
  const mediumAddr = medium.filter(r => r.kind === 'fact' && r.key === 'address_as');
  for (const r of mediumAddr) console.log(`  medium address_as: ${r.agent_handle} "${short(r.body, 24)}" status=${r.status} source=${r.source ?? '?'} @${r.created_at?.slice(0, 10) ?? '?'}`);

  // ── 9. Mechanism verdict ────────────────────────────────────────────────────
  console.log('\n§9 MECHANISM VERDICT');
  const contaminated = evidence.filter(e => e.verdict === 'LIKELY_CONTAMINATED');
  const findings: string[] = [];
  if (crossWrites > 0) findings.push(`REMEMBER_USER: ${crossWrites} model-directed cross-handle profile write(s) observed in turn history — the unvalidated remember_user vector FIRED.`);
  if (sharedThreads.length && (docHits.length || contaminated.some(c => c.source !== 'profile.name'))) {
    findings.push(`DOSSIER/REFLEXION HARVEST: shared thread(s) exist AND cross-user values sit in dossier/long-doc/address_as tiers — the unattributed-transcript harvest vector is the likely carrier of nickname+style.`);
  } else if (sharedThreads.length) {
    findings.push(`SHARED THREADS exist (${sharedThreads.length}) — harvest vector was reachable; no doc contamination found in the retained window.`);
  }
  if (caseDupes.length || formatDupes.length) findings.push('HANDLE VARIANTS: same identity split/merged across handle strings — inspect inbound handle normalization (channels/web/identity.ts, channels/bridge/inboundRouter.ts).');
  if (contaminated.some(c => c.source === 'profile.name') && crossWrites === 0) {
    findings.push('profile.name contamination WITHOUT an observed remember_user cross-write in the retained turn window — either the write predates retention, or a path outside the fixed writers is involved. Investigate before assuming coverage.');
  }
  if (!findings.length) findings.push('No mechanism confirmed from retained data. Evidence may have aged out (7-day messages / 30-day turns). Re-run right after the next reproduction, and check §2/§3 inventories manually.');
  for (const f of findings) console.log(`  → ${f}`);

  console.log('\n§10 Suggested MANUAL remediation (this script writes nothing):');
  for (const e of contaminated) {
    const how = e.source === 'profile.name' ? `null user_profiles.name for ${e.handle}`
      : e.source === 'prefs.address_as' ? `remove prefs.address_as from agent_memory[${e.handle}]`
      : e.source === 'medium.address_as' ? `retire the memory_medium address_as row for ${e.handle}`
      : `review directive for ${e.handle}`;
    console.log(`  • "${short(e.value, 32)}" on ${e.handle} [${e.source}] → ${how}`);
  }
  for (const hit of docHits) console.log(`  • edit doc: ${hit.trim().replace(/^⚠ /, '')}`);
  if (!contaminated.length && !docHits.length) console.log('  (nothing flagged)');

  if (csvPath) {
    const { writeFileSync } = await import('node:fs');
    const rows = [
      'handle,source,value,when,meta,self_count,foreign_handles,verdict',
      ...evidence.map(e => [e.handle, e.source, JSON.stringify(e.value), e.when ?? '', e.meta ?? '', e.selfCount, e.foreignHandles.join(';'), e.verdict].join(',')),
    ];
    writeFileSync(csvPath, rows.join('\n'), 'utf8');
    console.log(`\nCSV written: ${csvPath}`);
  }

  if (focusHandles.length) {
    console.log(`\n(Focus handles requested: ${focusHandles.join(', ')} — grep the sections above for them.)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
