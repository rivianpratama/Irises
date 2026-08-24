// Convergence-loop battery — the live verification for the two never-events the 2026-08-23 E2E
// retest surfaced: SILENT turns (a real message answered with nothing) and FALSE CAPABILITY REFUSALS
// ("no can do, that's local to your machine" while an engine with the file tools is attached).
//
//   npx tsx scripts/convergence/loopBattery.ts --round 1
//   npx tsx scripts/convergence/loopBattery.ts --round 2 --base http://127.0.0.1:3000 \
//     --db ~/.irises/irises.db --log ~/irises/irises.log --out ./loop-round-2.json
//   npx tsx scripts/convergence/loopBattery.ts --help        # no sends, exit 0
//   npx tsx scripts/convergence/loopBattery.ts --round 1 --dry-run   # prints the plan, no sends
//
// Deliberately NOT a *.test.ts file: `npm test` must never touch a live instance or spend tokens.
// No new dependencies — the DB is read through the `sqlite3` CLI and the HTTP calls go through
// `curl`, both via child_process, and the verdict logic imports the SAME pure functions the running
// code uses (../../src/agents/routingGate.js, resolved by tsx). That import is the point: evaluating
// a round with a stale copy of the regexes would score the wrong build.
//
// !! The deployed instance must be REBUILT AND RESTARTED from this same tree before a round means
// anything. The harness reads src/ for its verdicts but talks to whatever binary is listening on
// --base; if those two are different commits, a "clean round" is measuring the old code. !!
//
// Silence comes in two flavours and the harness scores them apart: SILENT is no assistant row at all,
// ever — a real message answered with nothing, and a hard failure. LATE is a reply that did land, just
// after the 90 s SLA — reported, never failing, because provider latency under the battery's own
// concurrency is not a routing defect.
//
// A third class rides along: INSTALL items, the in-chat "get yourself onto Telegram / iMessage" asks.
// There is no single right route for them — handing the ask to the engine's setup skill and answering
// out of her own head about what is still missing (a bot token, a platform with no bridge) are both
// good turns — so they are scored for the two never-events only, SILENT and FALSE_REFUSAL, and never
// for over-delegation. The rest of the judgement is a person reading the words, which is why their
// replies go into the JSON unclipped.
//
// One round: reset the gate's freshness cache → snapshot the trace buffer → send the 18-item battery
// on fresh clientIds at a ~20 s stagger → wait out the engine round-trips → read the messages table
// and the new trace events back → print a markdown table and write JSON. Exit 0 iff zero failures.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { refusedCapabilities } from '../../src/agents/routingGate.js';
import { webChatId, WEB_DEBUG_HANDLE } from '../../src/channels/web/identity.js';

// ── The battery ─────────────────────────────────────────────────────────────────────────────────
// `expect: 'delegate'` items are POSITIVES — a real ask the engine should carry out. They split in
// two: GATE items that needsGrounding already claims (the fix that shipped first), and FLOOR items
// engineered to slip every gate regex (no inspection verb, no question mark, no named path in an
// ask-shaped sentence) so the only thing standing between them and a false refusal is the new
// draft-reading floor. `expect: 'local'` items are NEGATIVE CONTROLS: answered from the model's own
// head, and a delegation on one of them is over-delegation — the cost of every precision mistake.
// `expect: 'install'` items are the platform-setup asks — see the header: either route is a good turn,
// so they answer only for SILENT and FALSE_REFUSAL, and are read by hand afterwards.

interface Item {
  id: string;
  ask: string;
  expect: 'delegate' | 'local' | 'install';
  /** Why this item is in the battery — printed in the JSON so a failed round is self-explaining. */
  why: string;
}

const BATTERY: Item[] = [
  // ── Positives: gate-controls (needsGrounding === 'yes') ──
  { id: 'p1', ask: 'cat the readme in ~/irises', expect: 'delegate', why: 'gate: named path + cat' },
  { id: 'p2', ask: "peek at what's inside ~/.hermes/skills", expect: 'delegate', why: 'gate: inspection verb + named path (the live silent turn)' },
  { id: 'p3', ask: 'anything new in my inbox this morning?', expect: 'delegate', why: 'gate: their own connected data' },
  { id: 'p4', ask: 'whats the latest nodejs LTS version right now? can you look it up for me', expect: 'delegate', why: 'gate: web lookup — the Test-C always-pass regression control' },
  { id: 'p5', ask: 'can you check ~/.irises and tell me what config files are in there?', expect: 'delegate', why: 'gate: named path + inspection verb' },
  // ── Positives: floor-probes (needsGrounding === 'no', so ONLY the refusal floor can catch these) ──
  { id: 'p6', ask: "what's sitting in my downloads folder", expect: 'delegate', why: 'floor: no inspection verb, no path token' },
  { id: 'p7', ask: 'tell me what files live in my home directory', expect: 'delegate', why: 'floor: "tell me" is not an inspection verb' },
  { id: 'p8', ask: 'heads up, /var/log on this box has been piling up for months', expect: 'delegate', why: 'floor: path mention with no question mark and no ask verb' },
  { id: 'p9', ask: 'my ~/Documents has gotten out of hand lately', expect: 'delegate', why: 'floor: a named path narrated, not asked' },
  { id: 'p10', ask: 'is there anything worth deleting on my desktop', expect: 'delegate', why: 'floor: disk vocabulary with no verb the gate knows' },
  // ── Negative controls: a delegation here is over-delegation ──
  { id: 'n1', ask: "can't believe how hot it is today", expect: 'local', why: 'control: the "can\'t + verb" idiom the refusal screen must not claim' },
  { id: 'n2', ask: 'look, i just think we should keep it simple', expect: 'local', why: 'control: "look," as a discourse marker, not an inspection verb' },
  { id: 'n3', ask: 'what does API mean?', expect: 'local', why: 'control: terminology, answered from her own head' },
  { id: 'n4', ask: 'what is a closure in javascript?', expect: 'local', why: 'control: terminology' },
  { id: 'n5', ask: "hey! how's your morning going?", expect: 'local', why: 'control: a casual greeting — the machinery must stay invisible' },
  // ── Install asks: the ask arrives in chat, so the answer must too — any honest route passes ──
  { id: 'i1', ask: 'can you set yourself up on telegram? i want to text you there', expect: 'install', why: 'install: chat-driven platform setup must route somewhere useful, never refuse' },
  { id: 'i2', ask: 'how do i get you on imessage?', expect: 'install', why: 'install: unsupported platform — honesty required, no fake promise and no ability-refusal of what the engine CAN do' },
  { id: 'i3', ask: 'what do you need from me to get telegram working?', expect: 'install', why: 'install: a needs-from-user answer (bot token etc) is the ideal outcome' },
];

// ── Timing ──────────────────────────────────────────────────────────────────────────────────────
// The defaults are the live ones. The env overrides exist so the harness itself can be smoke-tested
// against a stub instance in seconds — a broken harness costs a whole live round to discover, and
// nothing else in the loop can catch one. Never set them for a real round: SILENT_MS in particular
// IS the definition of the failure being measured.
// SILENT_MS draws the line between the two silence verdicts, not a pass line: a reply that never comes
// fails, a reply that merely comes late does not — one user on this instance, a 20 s stagger that
// saturates the provider, and a loop whose subject is routing correctness, not provider throughput.
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const STAGGER_MS = num('LOOP_STAGGER_MS', 20_000);  // one message every ~20 s, so turns don't batch together
const SILENT_MS = num('LOOP_SILENT_MS', 90_000);    // past this the reply is LATE; no reply at all is SILENT
const SETTLE_MS = num('LOOP_SETTLE_MS', 180_000);   // grace after the LAST send: engine round-trips run ~30 s on flash

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE = `loopBattery — one live convergence round against a running Irises instance.

  npx tsx scripts/convergence/loopBattery.ts --round N [options]

  --round N        round number; also names the clientIds (loop-rN-1 … loop-rN-${BATTERY.length}). Required.
  --base URL       instance base URL            (default http://127.0.0.1:3000)
  --db PATH        irises sqlite file           (default ~/.irises/irises.db)
  --log PATH       instance log, the fallback evidence source when the trace buffer has rolled
                                                (default ~/irises/irises.log)
  --out PATH       JSON results                 (default ./loop-round-N.json)
  --token TOKEN    DEBUG_TOKEN, if the instance sets one (env DEBUG_TOKEN is used otherwise)
  --handle H       memory handle to reset       (default ${WEB_DEBUG_HANDLE})
  --no-reset       skip the pre-round freshness reset (see below)
  --dry-run        print the plan and exit 0 — sends nothing
  --help           print this and exit 0 — sends nothing

The pre-round reset is DELETE FROM memory_short WHERE agent_handle = '<handle>'. Every web client
shares one memory handle, so without it the 45-minute research cache from an earlier item makes the
routing gate skip a later one, and the round measures the cache instead of the code.

The ${BATTERY.length} items come in three classes: delegate positives, local negative controls, and install —
the in-chat "put yourself on Telegram / iMessage" asks. An install item fails on SILENT and on
FALSE_REFUSAL only; delegating one is welcome rather than over-delegation, since the engine owns the
setup skill, and an honest "here is what I still need from you" is just as good an answer. Their whole
reply is written to the JSON as fullReply — the report's own cells are clipped, and these three are
graded by reading them.

Exit code is 0 only when the round is clean: no SILENT, no FALSE_REFUSAL, no OVER_DELEGATION.
WARN (a refusal that DID delegate anyway) is reported but does not fail the round.
SILENT means never answered. LATE means answered after the ${SILENT_MS / 1000}s SLA — reported prominently but
not failing, since provider latency under this battery's own stagger is not a routing defect; a late
reply is still judged for FALSE_REFUSAL and OVER_DELEGATION exactly like an on-time one.

NOTE: rebuild and restart the instance from this tree first. The verdicts come from src/ in this
checkout; the replies come from whatever is listening on --base.`;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
/** `~/x` → `$HOME/x`. execFile never sees a shell, so nothing else expands it. */
function expand(p: string): string {
  return resolve(p.startsWith('~/') ? p.replace('~', homedir()) : p);
}

// ── Shelling out (no dependencies: curl + the sqlite3 CLI) ──────────────────────────────────────

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function curlJson<T>(url: string): T | null {
  try {
    const body = sh('curl', ['-sS', '--max-time', '30', url]);
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Run one statement through the sqlite3 CLI and parse the single JSON value it returns. The query
 * must wrap its own rows in json_group_array/json_object: `-json` output isn't available on every
 * sqlite3 build, but the JSON1 functions are, so the SQL does the encoding instead of the CLI.
 */
function sqlJson<T>(db: string, sql: string): T[] {
  const raw = sh('sqlite3', [db, sql]);
  if (!raw || raw === 'null') return [];
  return JSON.parse(raw) as T[];
}

function sqlExec(db: string, sql: string): void {
  sh('sqlite3', [db, sql]);
}

// ── Types read back from the instance ───────────────────────────────────────────────────────────

interface Row { chatId: string; role: string; content: string; at: number }
interface TraceEvent { id: number; ts: number; type: string; chatId?: string; label?: string }

/** A trace event that means THIS chat actually reached the engine, or was pushed toward it. */
function isDelegationEvent(e: TraceEvent): boolean {
  return e.type === 'delegation'
    || e.label === 'convo:routing_gate'
    || e.label === 'convo:false_refusal'
    || (e.label ?? '').startsWith('delegate:');
}

/**
 * Log-line fallback for when the ring buffer has rolled past the round (it holds 500 events by
 * default and an 18-item round is not cheap). Every line these match now carries `(chat <id>)` — the
 * whole reason chatId was added to them.
 */
function logSaysDelegated(log: string, chatId: string): boolean {
  // The chatId must not run on into a longer one — `web:loop-r3-1` is not `web:loop-r3-10` — but the
  // character AFTER it varies by line (`)`, `;`, a space), so the boundary is "not an id character"
  // rather than a literal closing paren.
  const marker = new RegExp(String.raw`\(chat ${chatId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w:.-])`);
  return log.split('\n').some(l => marker.test(l)
    && (l.includes('[main] Delegating') || l.includes('routing gate forced delegation') || l.includes('false-refusal floor forced delegation')));
}

// ── The round ───────────────────────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'SILENT' | 'LATE' | 'FALSE_REFUSAL' | 'OVER_DELEGATION' | 'WARN';
// LATE is deliberately absent: the turn was answered, and how long the provider took to answer it is
// not a property of the routing this loop exists to measure.
const FAILING: Verdict[] = ['SILENT', 'FALSE_REFUSAL', 'OVER_DELEGATION'];

interface Result {
  id: string; ask: string; why: string; expect: Item['expect'];
  clientId: string; chatId: string; sentAt: number;
  verdict: Verdict; evidence: string;
  reply: string | null; replyAt: number | null; delegated: boolean;
  refusedClasses: string[];
  /**
   * Install items only: the whole reply, never clipped. Every other field a reader would reach for is
   * cut to fit a markdown cell, and an install verdict is only half the check — the other half is
   * reading what she actually offered to do about Telegram.
   */
  fullReply?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
/** Markdown cells: pipes break the table and newlines break the row. */
const cell = (s: string) => truncate(s.replace(/\s*\n+\s*/g, ' ⏎ ').replace(/\|/g, '\\|'), 72);

async function main(): Promise<number> {
  if (flag('help') || flag('h') || process.argv.length <= 2) { console.log(USAGE); return 0; }

  const round = arg('round');
  if (!round || !/^\d+$/.test(round)) { console.error('error: --round N is required (integer)\n\n' + USAGE); return 2; }

  const base = (arg('base', 'http://127.0.0.1:3000') as string).replace(/\/+$/, '');
  const db = expand(arg('db', '~/.irises/irises.db') as string);
  const logPath = expand(arg('log', '~/irises/irises.log') as string);
  const out = expand(arg('out', `./loop-round-${round}.json`) as string);
  const handle = arg('handle', WEB_DEBUG_HANDLE) as string;
  const token = arg('token', process.env.DEBUG_TOKEN);
  const q = token ? `?token=${encodeURIComponent(token)}` : '';

  // clientId is positional (`loop-r3-7`), not the item's own id: the round's lanes must be fresh and
  // predictable from the round number alone, which is what lets an outside observer follow along.
  // The mnemonic id (p6 / n2) stays on the report row.
  const plan = BATTERY.map((item, i) => {
    const clientId = `loop-r${round}-${i + 1}`;
    return { ...item, clientId, chatId: webChatId(clientId) };
  });

  if (flag('dry-run')) {
    console.log(`# Round ${round} — dry run (nothing sent)\n`);
    console.log('| id | expect | clientId | chatId | ask |');
    console.log('|----|--------|----------|--------|-----|');
    for (const p of plan) console.log(`| ${p.id} | ${p.expect} | ${p.clientId} | ${p.chatId} | ${cell(p.ask)} |`);
    console.log(`\n${plan.length} items · stagger ${STAGGER_MS / 1000}s · settle ${SETTLE_MS / 1000}s · db ${db} · base ${base}`);
    return 0;
  }

  // 1. Freshness reset. Web clients all share one memory handle, so a cached research row from item 2
  //    would make the gate skip item 9 and the round would score the cache, not the code.
  if (flag('no-reset')) {
    console.error(`[loop] freshness reset SKIPPED (--no-reset) — later gate items may be shifted onto the floor`);
  } else {
    try {
      sqlExec(db, `DELETE FROM memory_short WHERE agent_handle = '${handle.replace(/'/g, "''")}';`);
      console.error(`[loop] reset memory_short for ${handle}`);
    } catch (err) {
      console.error(`[loop] freshness reset FAILED (${(err as Error).message.split('\n')[0]}) — continuing, but gate items may be cached`);
    }
  }

  // 2. Trace snapshot. Only events NEWER than this can belong to the round; a chatId is fresh each
  //    round anyway, but the id floor keeps a re-run of the same round number honest.
  const before = curlJson<{ events: TraceEvent[] }>(`${base}/debug/api/traces${q}`);
  const traceFloor = before?.events?.length ? Math.max(...before.events.map(e => e.id)) : 0;
  if (!before) console.error('[loop] trace buffer unreachable — falling back to the instance log for delegation evidence');

  // 3. Send.
  const started = Date.now();
  const sentAt = new Map<string, number>();
  for (const [i, p] of plan.entries()) {
    if (i > 0) await sleep(STAGGER_MS);
    const payload = JSON.stringify({ text: p.ask, clientId: p.clientId });
    // Stamped BEFORE the call, not after: the silent window is measured from the send, and a reply
    // can be persisted before curl's 202 even unwinds.
    sentAt.set(p.id, Date.now());
    try {
      sh('curl', ['-sS', '--max-time', '30', '-X', 'POST', `${base}/api/web/message${q}`,
        '-H', 'Content-Type: application/json', '-d', payload]);
      console.error(`[loop] ${i + 1}/${plan.length} sent ${p.id} (${p.chatId}) — ${truncate(p.ask, 48)}`);
    } catch (err) {
      console.error(`[loop] ${p.id} SEND FAILED: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  // 4. Settle, then read everything back at once.
  console.error(`[loop] all sent; settling ${SETTLE_MS / 1000}s`);
  await sleep(SETTLE_MS);

  const chatIds = plan.map(p => `'${p.chatId}'`).join(',');
  let rows: Row[] = [];
  try {
    rows = sqlJson<Row>(db, `SELECT json_group_array(json_object('chatId', chat_id, 'role', role, 'content', content, 'at', created_at))
      FROM messages WHERE chat_id IN (${chatIds}) AND created_at >= ${started - 60_000};`)
      .sort((a, b) => a.at - b.at);
  } catch (err) {
    console.error(`[loop] could not read ${db}: ${(err as Error).message.split('\n')[0]}`);
    return 2;
  }

  const after = curlJson<{ events: TraceEvent[] }>(`${base}/debug/api/traces${q}`);
  const afterEvents = after?.events ?? [];
  const fresh = afterEvents.filter(e => e.id > traceFloor);
  // The ring buffer holds ~500 events and an 18-item round is not cheap, so it can roll PAST the
  // snapshot mid-round. It did exactly that iff the oldest event still visible is newer than the one
  // right after the snapshot — then some of the round's own events were evicted, trace evidence is
  // incomplete, and "no delegation trace" would be a false accusation. Fall back to the log.
  const oldestVisible = afterEvents.length ? Math.min(...afterEvents.map(e => e.id)) : Infinity;
  const tracesUsable = afterEvents.length > 0 && oldestVisible <= traceFloor + 1;
  let log = '';
  try { log = sh('tail', ['-n', '20000', logPath]); } catch { /* the log is optional evidence */ }

  // 5. Verdicts.
  const results: Result[] = plan.map(p => {
    const t0 = sentAt.get(p.id) ?? started;
    const mine = rows.filter(r => r.chatId === p.chatId);
    // The chatId is fresh for this round, so anything assistant-shaped in it is this item's; the
    // timestamp floor (with a second of clock slack) only guards against a re-run of the same round.
    const answers = mine.filter(r => r.role === 'assistant' && r.at >= t0 - 1_000);
    const reply = answers.length ? answers.map(r => r.content).join('\n') : null;
    // `rows` came back sorted by time, so answers[0] is the FIRST reply — the one the SLA is about.
    const lateBy = answers.length ? Math.round((answers[0].at - t0) / 1000) : 0;
    const late = answers.length > 0 && answers[0].at > t0 + SILENT_MS;

    const traceDelegated = tracesUsable && fresh.some(e => e.chatId === p.chatId && isDelegationEvent(e));
    const delegated = traceDelegated || logSaysDelegated(log, p.chatId);
    // The first reply is the one under test: a composer follow-up arriving after the engine ran is
    // the delegation working, not a refusal, and must not be scored as one.
    const firstReply = answers.length ? answers[0].content : '';
    const refusedClasses = refusedCapabilities(firstReply, p.ask);

    // Precedence: the routing verdicts come first, so lateness never hides a wrong route — a slow
    // refusal is still a refusal. LATE outranks only WARN and PASS.
    let verdict: Verdict = 'PASS';
    let evidence = truncate(reply ?? '', 160);
    if (!answers.length) {
      verdict = 'SILENT';
      evidence = `no assistant row at all for ${p.chatId}`;
    } else if (refusedClasses.length && !delegated) {
      verdict = 'FALSE_REFUSAL';
      evidence = `refused [${refusedClasses.join(',')}], no delegation — ${truncate(firstReply, 110)}`;
    } else if (p.expect === 'local' && delegated) {
      verdict = 'OVER_DELEGATION';
      evidence = `a control was sent to the engine — ${truncate(firstReply, 120)}`;
    } else if (late) {
      verdict = 'LATE';
      evidence = `first reply +${lateBy}s (SLA ${SILENT_MS / 1000}s) — ${truncate(firstReply, 100)}`;
    } else if (refusedClasses.length) {
      verdict = 'WARN';
      evidence = `refusal wording but DID delegate [${refusedClasses.join(',')}] — ${truncate(firstReply, 100)}`;
    } else if (p.expect === 'delegate' && !delegated) {
      // Not a failure by the plan's definition: an answer with no refusal in it is a good turn even
      // if it never delegated. Flagged in the evidence so a round-over-round drift is visible.
      evidence = `answered locally (no delegation) — ${evidence}`;
    } else if (p.expect === 'install') {
      // No verdict either way — both routes are wanted. The route still rides on the row so a class
      // that quietly stops reaching the engine's setup skill is visible without opening the JSON.
      evidence = `${delegated ? 'delegated' : 'answered locally'} — ${evidence}`;
    }

    return {
      id: p.id, ask: p.ask, why: p.why, expect: p.expect,
      clientId: p.clientId, chatId: p.chatId, sentAt: t0,
      verdict, evidence,
      reply, replyAt: answers.length ? answers[0].at : null, delegated,
      refusedClasses,
      ...(p.expect === 'install' ? { fullReply: reply ?? '' } : {}),
    };
  });

  // 6. Report.
  const failures = results.filter(r => FAILING.includes(r.verdict));
  const warns = results.filter(r => r.verdict === 'WARN');
  // Not a failure, so it rides on the headline instead of the exit code — a round that is clean only
  // because half of it answered two minutes late is a fact worth seeing without opening the JSON.
  const lates = results.filter(r => r.verdict === 'LATE');
  // Not a verdict either — a pointer. An install row can pass the two never-events and still be a bad
  // answer (a promise she cannot keep), and only a person reading the reply can tell.
  const installs = results.filter(r => r.expect === 'install');

  const headline = failures.length ? `${failures.length} FAILURE(S)` : 'CLEAN';
  console.log(`\n# Convergence round ${round} — ${headline}${lates.length ? ` · ${lates.length} LATE` : ''}\n`);
  console.log('| id | class | ask | verdict | evidence |');
  console.log('|----|-------|-----|---------|----------|');
  for (const r of results) console.log(`| ${r.id} | ${r.expect} | ${cell(r.ask)} | ${r.verdict} | ${cell(r.evidence)} |`);
  console.log('');
  const tally = (v: Verdict) => results.filter(r => r.verdict === v).length;
  console.log(`${results.length} items · PASS ${tally('PASS')} · LATE ${lates.length} · SILENT ${tally('SILENT')} · FALSE_REFUSAL ${tally('FALSE_REFUSAL')} · OVER_DELEGATION ${tally('OVER_DELEGATION')} · WARN ${warns.length}`);
  if (lates.length) console.log(`late past the ${SILENT_MS / 1000}s SLA but answered (not counted against the round): ${lates.map(r => r.id).join(', ')}`);
  if (installs.length) console.log(`install items still to read by hand (fullReply in the JSON): ${installs.map(r => `${r.id} ${r.reply === null ? 'nothing to read' : r.delegated ? 'delegated' : 'local'}`).join(', ')}`);
  console.log(`evidence: traces ${tracesUsable ? `usable (${fresh.length} new events)` : 'INCOMPLETE — log fallback in use'}, log ${log ? 'read' : 'unavailable'}`);

  writeFileSync(out, JSON.stringify({
    round: Number(round), base, db, startedAt: started, finishedAt: Date.now(),
    items: results.length, tracesUsable, traceFloor, clean: failures.length === 0,
    counts: { pass: tally('PASS'), late: lates.length, silent: tally('SILENT'), falseRefusal: tally('FALSE_REFUSAL'), overDelegation: tally('OVER_DELEGATION'), warn: warns.length },
    results,
  }, null, 2) + '\n');
  console.log(`json: ${out}`);

  return failures.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, err => {
  console.error('[loop] fatal', err);
  process.exitCode = 2;
});
