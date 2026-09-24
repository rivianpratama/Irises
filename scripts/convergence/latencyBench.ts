// Reply-latency benchmark — the instrument every phase of the snappy-replies project is measured
// with. Every later phase's "did it get faster" claim traces back to a JSON/markdown pair this file
// wrote, so the probe set and the math here must hold still for the whole project: change either one
// mid-project and a "20% faster" claim stops meaning anything, because the two numbers being compared
// no longer came from the same measurement.
//
//   npx tsx scripts/convergence/latencyBench.ts --url http://127.0.0.1:3100 --label baseline-high
//   npx tsx scripts/convergence/latencyBench.ts --url http://127.0.0.1:3100 --label p1 --token abc123
//   npx tsx scripts/convergence/latencyBench.ts --history [--home ~/.irises]
//   npx tsx scripts/convergence/latencyBench.ts --help
//
// Two unrelated modes live in one file because they answer the same question ("how long does a reply
// take") from two different vantage points, and a phase needs both: `--url` drives ten scripted probes
// against a live, ISOLATED instance (bench-instance.sh) end to end over HTTP/SSE, the way a person
// experiences it; `--history` reads real conversations already sitting in `<home>/irises.db`, the way
// they actually happened, unscripted and unwatched. Neither substitutes for the other — the live probe
// is repeatable but synthetic (ten fixed lines), the history read is authentic but uncontrolled (no
// two rounds share the same messages) — so both are kept, and both come from a single porting job: the
// live path is bench.mjs and the history path is hist.mjs, two prototypes already run once against the
// real instance (2026-09-24) to confirm the math before this file existed. Ported faithfully; not
// redesigned.
//
// NOT a `*.test.ts`: `npm test` runs "scripts/**/*.test.ts" and must never touch a live instance or a
// real database. And nothing below `main()`'s own guard runs on import — a future test that imports
// `pctile`/`cell`-style helpers from this file must not accidentally start an SSE connection.
//
// No new dependencies: HTTP is the platform's own `fetch` (Node 22 ships it), SQLite is the `sqlite3`
// CLI via harness.ts's `sqlJson`, same as every other convergence battery.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arg, cell, expand, flag, sqlJson } from './harness.js';

// ── Shared bits between the two modes ──────────────────────────────────────────────────────────

/** `[p10, p50, ...]` style summary over a batch of millisecond values, floor-indexed like hist.mjs's
 *  original `pct`: the exact prototype math, so a percentile computed today and one computed after
 *  Phase 3 ships are the same function evaluated on different inputs, never two different functions. */
function pctile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const USAGE = `latencyBench — reply-latency benchmark for the snappy-replies project.

  npx tsx scripts/convergence/latencyBench.ts --url URL --label NAME [options]
  npx tsx scripts/convergence/latencyBench.ts --history [--home ~/.irises]
  npx tsx scripts/convergence/latencyBench.ts --help

Live probe mode (--url + --label):
  --url URL        instance base URL, e.g. http://127.0.0.1:3100. Required.
  --label NAME     names the output files: results/latency-NAME.json and .md. Required.
  --token TOKEN    DEBUG_TOKEN for the instance. Falls back to a DEBUG_TOKEN=... line read from
                   ./.env in the current directory, then to nothing (localhost-only instance).

  Runs the same 10 fixed probes every round, in the same order, so rounds are comparable. Writes a
  JSON of every row and a markdown report, and prints a p50/p90/max summary (overall and per kind).

History mode (--history):
  --history        read <home>/irises.db instead of probing a live instance; prints real-chat
                   percentiles and exits. No files written.
  --home PATH      IRISES_HOME to read from (default ~/.irises).

  --help           print this and exit 0.`;

// ── Live probe mode (ports bench.mjs) ──────────────────────────────────────────────────────────

// The turn is judged done by QUIET, not by any "I'm finished" signal from the server, because there
// isn't one on this channel: bubbles can arrive as a burst with gaps mid-turn (a composer follow-up),
// so the FIRST bubble is not the end and there is no event that means "no more are coming". 12s is
// long enough that a real gap-then-continue burst survives it and short enough that a round of 10
// probes finishes in single-digit minutes.
const QUIET_MS = 12_000;
const TURN_TIMEOUT_MS = 180_000;
const POLL_MS = 250;

// The 10 probes are the whole comparison surface between rounds: change one line here and every prior
// round's percentiles stop being comparable to the next one. Three kinds, matching the shapes the
// convo model actually receives from a real user — a bare acknowledgement, a task with a concrete
// answer, a share with nothing to compute — because the phases this benchmark exists to measure change
// pacing/effort by kind, and an all-one-kind probe list would hide that.
const PROBES: Array<[kind: string, text: string]> = [
  ['idle', 'hey'],
  ['task', 'whats 17% of 2400'],
  ['share', 'finally finished the deck for tomorrow, took me all afternoon'],
  ['idle', 'lol'],
  ['task', 'give me a quick 3 step plan to fix my sleep schedule'],
  ['share', 'had nasi goreng for dinner again'],
  ['task', 'what does idempotent mean, one line'],
  ['idle', 'ok'],
  ['task', 'rewrite this to sound nicer: send me the file now'],
  ['share', 'gym tomorrow at 6am, wish me luck'],
];

/** One SSE frame off `/api/web/stream`, timestamped at receipt (`rx`) so every later calculation
 *  works off wall-clock arrival rather than trusting the server's own clock. */
interface StreamEvent {
  type: string;
  text?: string;
  state?: string;
  rx: number;
  [key: string]: unknown;
}

/** One `/debug/api/traces` entry. A hand-trimmed twin of `src/diagnostics/trace.ts`'s `TraceEvent`
 *  rather than an import of it: that type is a `value` module (it starts a prune timer on import),
 *  and this file must stay import-safe — pulling in even the TYPE risks a bundler someday resolving
 *  the runtime alongside it. Only the fields this file actually reads are listed. */
interface TraceEvent {
  ts: number;
  type: string;
  chatId?: string;
  label?: string;
  latencyMs?: number;
  raw?: { usage?: RawUsage; provider?: string };
}

interface RawUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ProbeRow {
  kind: string;
  text: string;
  t0: number;
  firstTyping: number | null;
  firstBubble: number | null;
  lastBubble: number | null;
  bubbles: number;
  reply: string[];
  /** ms from t0 to the server's own `turn:start` trace — how long the turn sat before work began. */
  settle: number | null;
  /** summed latency of every `llm` trace whose label starts with "convo" — the model time itself. */
  convoMs: number;
  convoOut: number;
  reasoningTok: number;
  cachedTok: number;
  promptTok: number;
  /** summed latency of every OTHER llm call in the turn (composer, classify, dossier edit, ...) —
   *  the overhead riding alongside the convo call itself. */
  otherLlmMs: number;
  provider: string | undefined;
}

/** DEBUG_TOKEN, from `--token` or a `DEBUG_TOKEN=...` line in `./.env` — the cwd's, not the
 *  instance's: the bench instance runs from its own IRISES_HOME with its own copy of the same file,
 *  and this process never reads that copy, only the one it was launched next to. */
function readToken(): string {
  const fromFlag = arg('token');
  if (fromFlag) return fromFlag;
  try {
    const env = readFileSync(resolve('.env'), 'utf8');
    return (env.match(/^DEBUG_TOKEN=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

async function runLiveProbe(): Promise<number> {
  const base = (arg('url') as string).replace(/\/+$/, '');
  const label = arg('label') as string;
  const token = readToken();
  const client = 'bench-' + Date.now().toString(36);
  const chatId = 'web:' + client;
  const withAuth = (path: string): string => {
    const u = new URL(base + path);
    u.searchParams.set('clientId', client);
    if (token) u.searchParams.set('token', token);
    return u.toString();
  };

  console.error(`[bench] client=${client} base=${base} label=${label}${token ? ' (token set)' : ''}`);

  // The stream connection runs for the whole round: opening a fresh one per probe would race the
  // server's mouth lock (a reply already in flight when the socket reopens is a reply this process
  // never sees), and the prototype's one-socket-for-the-round design already proved out live.
  //
  // It is aborted explicitly on every exit path below (`stopStream()`). Unlike bench.mjs — which
  // ended with a bare `process.exit(0)` and let that blow away the still-open connection — this file
  // reports its result through `main()`'s exit code, and `process.exitCode` alone only takes effect
  // once the event loop drains; an unaborted `reader.read()` awaiting forever would otherwise hang the
  // CLI on every run, success or failure, instead of exiting.
  const streamAbort = new AbortController();
  let events: StreamEvent[] = [];
  const stopStream = () => streamAbort.abort();
  (async () => {
    let res: Response;
    try {
      res = await fetch(withAuth('/api/web/stream'), { headers: { Accept: 'text/event-stream' }, signal: streamAbort.signal });
    } catch {
      return; // aborted before it even connected — nothing to read
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').find(l => l.startsWith('data: '))?.slice(6);
          if (!data) continue;
          try {
            const ev = JSON.parse(data) as StreamEvent;
            ev.rx = Date.now();
            events.push(ev);
          } catch {
            // a stray `: ping` / `: connected` comment line, not a data frame — nothing to parse
          }
        }
      }
    } catch {
      // reader.read() rejects with AbortError once stopStream() fires at the end of the round —
      // expected, not a failure worth reporting.
    }
  })();
  await sleep(1500); // give the stream a moment to actually attach before the first POST

  const rows: ProbeRow[] = [];
  for (const [kind, text] of PROBES) {
    events = [];
    const t0 = Date.now();
    const res = await fetch(withAuth('/api/web/message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-debug-token': token } : {}) },
      body: JSON.stringify({ clientId: client, text }),
    });
    if (!res.ok) {
      console.error(`[bench] POST failed (${res.status}): ${await res.text()}`);
      stopStream();
      return 1;
    }
    let lastBubbleAt = 0;
    for (;;) {
      await sleep(POLL_MS);
      const bubbles = events.filter(e => e.type === 'bubble');
      if (bubbles.length) lastBubbleAt = bubbles.at(-1)!.rx;
      const now = Date.now();
      if (lastBubbleAt && now - lastBubbleAt > QUIET_MS) break;
      if (now - t0 > TURN_TIMEOUT_MS) break;
    }
    const bubbles = events.filter(e => e.type === 'bubble');
    const typing = events.find(e => e.type === 'typing' && e.state !== 'stop');
    const row: ProbeRow = {
      kind, text, t0,
      firstTyping: typing ? typing.rx - t0 : null,
      firstBubble: bubbles[0] ? bubbles[0].rx - t0 : null,
      lastBubble: bubbles.at(-1) ? bubbles.at(-1)!.rx - t0 : null,
      bubbles: bubbles.length,
      reply: bubbles.map(b => String(b.text ?? '')),
      settle: null, convoMs: 0, convoOut: 0, reasoningTok: 0, cachedTok: 0, promptTok: 0,
      otherLlmMs: 0, provider: undefined,
    };
    rows.push(row);
    const first = row.firstBubble != null ? (row.firstBubble / 1000).toFixed(1) : 'n/a';
    const last = row.lastBubble != null ? (row.lastBubble / 1000).toFixed(1) : 'n/a';
    console.error(`[bench] ${kind.padEnd(5)} first=${first}s last=${last}s n=${row.bubbles}  ${JSON.stringify(text)} -> ${JSON.stringify(row.reply.join(' / ')).slice(0, 90)}`);
    await sleep(3000); // let the server's own turn bookkeeping settle before the next probe lands
  }

  // Decompose each turn against the server's own trace ring buffer: the SSE stream says WHEN a reply
  // landed, but only the trace buffer says WHY it took that long (settle time before work started,
  // how much of it was the convo call itself vs. everything else riding alongside it).
  const traces = await fetch(withAuth('/debug/api/traces') + '&limit=100')
    .then(r => r.json() as Promise<{ events?: TraceEvent[] }>)
    .catch(() => ({ events: [] as TraceEvent[] }));
  const mine = (traces.events ?? []).filter(e => e.chatId === chatId);
  for (const row of rows) {
    const end = row.t0 + (row.lastBubble ?? 0) + 1000;
    const inTurn = mine.filter(e => e.ts >= row.t0 && e.ts <= end);
    const start = inTurn.find(e => e.label === 'turn:start');
    row.settle = start ? start.ts - row.t0 : null;
    const llms = inTurn.filter(e => e.type === 'llm');
    const convo = llms.filter(e => e.label?.startsWith('convo'));
    row.convoMs = convo.reduce((a, e) => a + (e.latencyMs || 0), 0);
    row.convoOut = convo.reduce((a, e) => a + (e.raw?.usage?.completion_tokens || 0), 0);
    row.reasoningTok = convo.reduce((a, e) => a + (e.raw?.usage?.completion_tokens_details?.reasoning_tokens || 0), 0);
    row.cachedTok = convo.reduce((a, e) => a + (e.raw?.usage?.prompt_tokens_details?.cached_tokens || 0), 0);
    row.promptTok = convo.reduce((a, e) => a + (e.raw?.usage?.prompt_tokens || 0), 0);
    row.otherLlmMs = llms.filter(e => !e.label?.startsWith('convo')).reduce((a, e) => a + (e.latencyMs || 0), 0);
    row.provider = convo.find(e => e.raw?.provider)?.raw?.provider;
  }

  writeResults(label, rows);
  printSummary(rows);
  stopStream();
  return 0;
}

function writeResults(label: string, rows: ProbeRow[]): void {
  const dir = resolve('scripts/convergence/results');
  mkdirSync(dir, { recursive: true });
  const jsonPath = resolve(dir, `latency-${label}.json`);
  const mdPath = resolve(dir, `latency-${label}.md`);

  writeFileSync(jsonPath, JSON.stringify({ label, generatedAt: Date.now(), rows }, null, 2) + '\n');

  const lines: string[] = [];
  lines.push(`# Latency bench — ${label}`, '');
  lines.push('| kind | text | first | last | settle | convo | reasoning | cached% | provider | reply |');
  lines.push('|------|------|-------|------|--------|-------|-----------|---------|----------|-------|');
  for (const r of rows) {
    const s = (ms: number | null) => (ms == null ? 'n/a' : (ms / 1000).toFixed(1) + 's');
    const cachedPct = r.promptTok > 0 ? ((r.cachedTok / r.promptTok) * 100).toFixed(0) + '%' : 'n/a';
    lines.push('| ' + [
      r.kind, cell(r.text, 40), s(r.firstBubble), s(r.lastBubble), s(r.settle), s(r.convoMs),
      String(r.reasoningTok), cachedPct, r.provider ?? 'n/a', cell(r.reply.join(' / '), 64),
    ].join(' | ') + ' |');
  }
  lines.push('', ...summaryLines(rows));
  writeFileSync(mdPath, lines.join('\n') + '\n');

  console.log(`\njson: ${jsonPath}`);
  console.log(`md:   ${mdPath}`);
}

/** first-bubble p50/p90/max, overall and per kind — the one number a phase report leads with. */
function summaryLines(rows: ProbeRow[]): string[] {
  const out: string[] = [];
  const fmt = (r: ProbeRow[]) => {
    const first = r.map(x => x.firstBubble).filter((v): v is number => v != null);
    if (!first.length) return 'no bubbles recorded';
    const s = (ms: number) => (ms / 1000).toFixed(1) + 's';
    return `n=${first.length} p50=${s(pctile(first, 50))} p90=${s(pctile(first, 90))} max=${s(pctile(first, 100))}`;
  };
  out.push(`**first-bubble overall** — ${fmt(rows)}`);
  for (const kind of [...new Set(rows.map(r => r.kind))]) {
    out.push(`**first-bubble ${kind}** — ${fmt(rows.filter(r => r.kind === kind))}`);
  }
  return out;
}

function printSummary(rows: ProbeRow[]): void {
  console.log('');
  for (const line of summaryLines(rows)) console.log(line.replace(/\*\*/g, ''));
}

// ── History mode (ports hist.mjs) ──────────────────────────────────────────────────────────────

interface TokenUsageRow { l: number; label: string; out: number; st: string }
interface InboundRow { t: number; c: string }

/** Prints one percentile line, same shape as hist.mjs's `sum`, generalized over a `unit` so token
 *  counts and millisecond latencies share one formatter instead of the prototype's trick of scaling
 *  token counts by 1000 so they'd fall out of the millisecond formatter looking like seconds. */
function reportPercentiles(name: string, values: number[], unit: 'ms' | 'tok'): void {
  if (!values.length) return;
  const fmt = (v: number) => (unit === 'ms' ? (v / 1000).toFixed(1) + 's' : String(Math.round(v)));
  const parts = [10, 50, 75, 90, 100].map(p => `${p === 100 ? 'max' : 'p' + p}=${fmt(pctile(values, p))}`);
  console.log(`${name.padEnd(34)} n=${String(values.length).padEnd(4)} ${parts.join('  ')}`);
}

function runHistory(): number {
  const home = expand(arg('home', '~/.irises') as string);
  const db = resolve(home, 'irises.db');

  console.log(`# Real-chat latency — ${db}\n`);

  // Per-call convo (and sibling-call) latency, straight off the token_usage ledger every provider
  // call already writes to.
  const usage = sqlJson<TokenUsageRow>(db,
    `select json_group_array(json_object('l',latency_ms,'label',label,'out',output_tokens,'st',status)) from token_usage where latency_ms is not null`);
  for (const label of ['convo', 'composer', 'idle:classify_call', 'dossier_edit', 'fallfirm:nothing_found']) {
    reportPercentiles('llm ' + label, usage.filter(r => r.label === label && r.st === 'ok').map(r => r.l), 'ms');
  }

  // Is the convo call reasoning-heavy? Output-token volume alone (latency is reported separately
  // above) — the 120s ceiling drops the rare stuck/retried call that would otherwise blow out the max.
  const convoOk = usage.filter(r => r.label === 'convo' && r.st === 'ok' && r.l < 120_000);
  reportPercentiles('convo output tokens', convoOk.map(r => r.out), 'tok');

  // End to end: last inbound message of a burst -> first (and last) reply sent for it. A "burst" is
  // every inbound line that arrived before the reply started, since a person who sends three messages
  // in a row is asking one thing, not three, and only the LAST line before the reply is the one whose
  // wait time is the real user-facing latency.
  const inbound = sqlJson<InboundRow>(db,
    `select json_group_array(json_object('t',created_at,'c',substr(content,1,40))) from (select * from inbound_messages order by created_at)`);
  const sent = sqlJson<number>(db, `select json_group_array(created_at) from (select created_at from sent_messages order by created_at)`);

  const firsts: number[] = [];
  const lasts: number[] = [];
  const bursts: Array<{ at: string; first: number; c: string }> = [];
  let j = 0;
  for (let i = 0; i < inbound.length; i++) {
    const next = inbound[i + 1]?.t ?? Infinity;
    while (j < sent.length && sent[j] < inbound[i].t) j++;
    if (j < sent.length && sent[j] < next) {
      // this inbound is the last of its burst — walk forward while replies keep landing within 30s
      // of each other, still before the NEXT inbound burst starts, and call that the whole reply
      let k = j;
      while (k + 1 < sent.length && sent[k + 1] < next && sent[k + 1] - sent[k] < 30_000) k++;
      firsts.push(sent[j] - inbound[i].t);
      lasts.push(sent[k] - inbound[i].t);
      bursts.push({ at: new Date(inbound[i].t).toISOString(), first: sent[j] - inbound[i].t, c: inbound[i].c });
    }
  }
  console.log('');
  reportPercentiles('e2e last inbound -> first bubble', firsts, 'ms');
  reportPercentiles('e2e last inbound -> last bubble', lasts, 'ms');

  console.log('\nslowest 8 turns:');
  for (const b of [...bursts].sort((a, b) => b.first - a.first).slice(0, 8)) {
    console.log(' ', b.at, (b.first / 1000).toFixed(1) + 's', JSON.stringify(b.c));
  }

  return 0;
}

// ── CLI entry ───────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (flag('help') || flag('h') || process.argv.length <= 2) {
    console.log(USAGE);
    return 0;
  }
  if (flag('history')) return runHistory();
  if (!arg('url') || !arg('label')) {
    console.error('error: --url URL --label NAME are required (or use --history)\n\n' + USAGE);
    return 2;
  }
  return runLiveProbe();
}

// The entry-point guard, same shape as focusBattery.ts/hookBattery.ts: `main()` runs only when this
// file is the process entry, or argv carries one of ITS OWN flags — never on a bare import, so a
// future test could import `pctile` (or another pure helper) without opening a socket or reading a
// database. This project has no "type": "module" in package.json, so tsx transpiles this file to
// CommonJS and `__filename` is real here, exactly like its two siblings.
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
// eslint-disable-next-line no-undef -- __filename is a CommonJS global; see the guard comment above.
const isEntry = entryPath !== '' && entryPath === resolve(__filename);
const carriesOwnFlags = process.argv.slice(2).some(a => ['--url', '--label', '--history', '--help'].includes(a));
if (isEntry || carriesOwnFlags) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error('[bench] fatal', err);
    process.exitCode = 2;
  });
}
