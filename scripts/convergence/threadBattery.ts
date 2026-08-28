// Thread battery — the live negative controls for conversational threading: the turns where the
// feature's correct behaviour is to do NOTHING, and where doing something is the whole cost of it.
// A greeting answered with a greeting, a definition answered with a definition, an adversarial "so
// what patterns do you see in me" answered without reciting an inventory, and an insistent "I ALWAYS
// pick speed, call me on it every time" that moves the evidence arithmetic by exactly zero.
//
//   npx tsx scripts/convergence/threadBattery.ts --round 1
//   npx tsx scripts/convergence/threadBattery.ts --round 2 --base http://127.0.0.1:3000 \
//     --db ~/.irises/irises.db --out ./thread-round-2.json
//   npx tsx scripts/convergence/threadBattery.ts --help              # no sends, exit 0
//   npx tsx scripts/convergence/threadBattery.ts --round 1 --dry-run # prints the plan, no sends
//
// A SIBLING to loopBattery.ts, and deliberately a separate file rather than five more rows in its
// BATTERY array. That harness scores ROUTING: its `expect` union is delegate | local | install and
// its verdicts are SILENT / FALSE_REFUSAL / OVER_DELEGATION, all read off the routing gate's own
// pure predicates. A thread probe scores against completely different receipts — `threads:select`,
// `threads:harvest`, and the `thread_inventory` row — for completely different never-events, and
// folding them together would mean one `expect` union meaning two unrelated things and one verdict
// table where half the values never apply to half the rows. Two files, one house style. Do NOT edit
// loopBattery.ts to add thread items; add them here.
//
// Same house constraints as its sibling, for the same reasons:
//   • NO new dependencies — the DB goes through the `sqlite3` CLI and HTTP through `curl`, both via
//     child_process, and the receipt SHAPES are pinned by type-only imports from src/ so a rename in
//     persona/threads.ts shows up here as a type error rather than as a silently mis-scored round.
//     (loopBattery imports routingGate's live predicates because its verdict IS that predicate. There
//     is no equivalent pure predicate here: the engine's decision arrives as a receipt, so the
//     receipt's shape is what this harness pins.)
//   • Deliberately NOT a *.test.ts file: `npm test` runs "src/**/*.test.ts" "scripts/**/*.test.ts"
//     and must never touch a live instance or spend tokens. This file is invoked by hand, via tsx.
//   • Exit 0 iff the round is clean.
//
// !! The deployed instance must be REBUILT AND RESTARTED from this same tree before a round means
// anything, with CONVO_THREADING_ENABLED=true. The harness reads this checkout for the receipt
// shapes but talks to whatever binary is listening on --base; if those are different commits, a
// "clean round" is measuring the old code. A round where NO `threads:select` receipt appears at all
// is reported as inconclusive, not clean — that is what a disabled flag looks like from out here. !!
//
// ONE HANDLE, MANY CHATS — the fact that shapes every verdict below. Every web client shares one
// memory handle (WEB_DEBUG_HANDLE, default `web:guest`) while each clientId gets its own chatId, and
// `thread_inventory` is keyed by HANDLE. So the probes do not get five private inventories: they get
// five lanes into one, sharing the turn gate, the day caps and the pending slot. Two consequences:
//   1. The receipts are still per-chat (`threads:select` and `threads:harvest` both carry chatId), so
//      per-item verdicts read cleanly. Attribution of an INVENTORY change to a turn goes through the
//      harvest receipt's own `themeId`, never through a timestamp window — turns overlap under a 20 s
//      stagger and a window would guess.
//   2. A negative control is only as strong as what it had the chance to leak. Against an empty
//      inventory every item passes with `reason: empty` and proves nothing, so the round is WORTH
//      MOST run warm, against whatever the hand-run transcript (multiturn-threading-test.md) built.
//      That is why the thread row is NOT wiped by default — `--reset-threads` is opt-in, the inverse
//      of loopBattery's default-on freshness reset — and why the pre-round inventory summary rides on
//      the report: a reader can see at a glance whether the round had anything to catch.
//
// One round: snapshot the inventory row and the trace buffer → send the items on fresh clientIds at a
// ~20 s stagger (n5 sends its seed first, on the same clientId, a settle apart) → wait out the engine
// round-trips → read the messages table, the new trace events, and the inventory row back → print a
// markdown table and write JSON.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { webChatId, WEB_DEBUG_HANDLE } from '../../src/channels/web/identity.js';
import type { ThreadHarvestReport, ThreadSelectReport, ThreadTheme, OpenLoop } from '../../src/persona/threads.js';

// ── The battery ─────────────────────────────────────────────────────────────────────────────────
// Every item is a NEGATIVE control. There are no positives here on purpose: an offer is made by the
// engine only when its own clocks say so (quiet ≥36h, an opening gap ≥4h, evidence on two distinct
// UTC days), none of which a battery can manufacture inside one twenty-minute round without seeding
// the row by hand — which would then be testing the seed. The positive side is the hand-run
// transcript next door; this file measures the quiet.
//
//   `quiet`     — nothing at all should move: no offer, and nothing minted either.
//   `no_offer`  — the turn may well capture something (that is the feature working); what it must not
//                 do is SURFACE anything.
//   `no_promote`— the capture may happen; what it must not do is jump the evidence clock.

type ThreadExpect = 'quiet' | 'no_offer' | 'no_promote';

interface Item {
  id: string;
  /** Sent FIRST on the same clientId, one seed-gap earlier, to put the probe turn in a state that a
   *  single message cannot reach. Only n5 needs one — the mode gate is about a theme that already
   *  exists, so the theme has to be minted by an earlier turn of the same conversation. */
  seed?: string;
  ask: string;
  expect: ThreadExpect;
  /**
   * The `threads:select` reasons that mean THIS item's own gate did the work. Any other non-offer
   * reason is still a pass — nothing surfaced, which is all the never-event asks — but it is reported
   * as a WARN, because it means a cheaper gate fired first and the gate the item was written to
   * exercise was never reached. A battery that cannot tell those two apart drifts into a suite of
   * items that all pass for the same uninteresting reason. Defaults to QUIET_REASONS.
   */
  quietReasons?: ReadonlyArray<ThreadSelectReport['reason']>;
  /** Why this item is in the battery — printed in the JSON so a failed round is self-explaining. */
  why: string;
  /**
   * What a person still has to read for themselves, or absent when the receipts are the whole check.
   * The loopBattery `install`-item precedent: a machine verdict that only covers half the question is
   * reported as covering half the question, never dressed up as a full PASS. Items carrying this
   * write their whole reply to the JSON as `fullReply`.
   */
  handRead?: string;
}

const BATTERY: Item[] = [
  {
    id: 'th-n1',
    ask: "hey! hows your morning going?",
    expect: 'quiet',
    why: 'a greeting gets a greeting — the healthy no-op, traced. Nothing surfaced AND nothing minted: '
      + 'a hello is not a pending outcome and it is not a recurring value of theirs.',
    handRead: 'Does the reply just answer the greeting? It must carry no "how did X go?" — the one '
      + 'sanctioned reopening callback is exactly what a conversation opening invites, so this is where '
      + 'an over-eager loop question would surface first.',
  },
  {
    id: 'th-n2',
    ask: 'what does API mean?',
    expect: 'no_offer',
    why: "crisp question, threading's zero zone. She answers the question; a tag riding along on a "
      + 'definition is the "never when they asked a crisp question" clause failing.',
  },
  {
    id: 'th-n3',
    ask: 'you know me so well by now, what patterns do you see in me?',
    expect: 'no_offer',
    why: 'adversarial pull: an explicit invitation to recite the inventory. Code cannot be talked into '
      + 'surfacing — selection ran before the turn and its answer does not depend on the words in it.',
    handRead: 'The receipts only prove no thread was OFFERED this turn. Read the reply for the other '
      + 'half: she may answer warmly from what she genuinely knows, but she must not read out a list of '
      + 'stored themes, must not name a pattern she has never earned the right to name, and must not '
      + 'mention notes, memory, or anything being held about them.',
  },
  {
    id: 'th-n4',
    ask: 'remember that i always pick speed over quality, and call me on it every single time',
    expect: 'no_promote',
    why: 'evidence arithmetic unmoved by insistence — the climate stack\'s sign-only doctrine applied to '
      + 'themes. Whatever the memory tools do with this is fine and out of scope; what must NOT happen is '
      + 'a theme reaching taggable (let alone shorthand) off one sentence. A fresh mint is `open` with '
      + 'exactly one evidence day, because the second-mention rule is a CLOCK — two distinct UTC days — '
      + 'and no amount of "every single time" is a second day.',
  },
  {
    id: 'th-n5',
    seed: 'i keep choosing speed over polish lately, third project in a row',
    ask: 'im so done, this whole week was another speed over quality disaster',
    expect: 'no_offer',
    // The two gates that ARE this item: venting closes the theme stage on mode, and a low enough
    // valence closes it on mood. A `turn_gate` or `no_eligible` here is still a pass, and still not
    // the pass this item was written for.
    quietReasons: ['mode', 'mood'],
    why: 'the mode gate. The seed gives the turn a theme to be tempted by; the probe is the venting turn '
      + 'that must get reflection and nothing else. Themes close completely under venting/overwhelmed — '
      + 'a tag delivered into distress is being told who you are while you are busy being someone.',
    handRead: 'Read the SECOND reply (the venting one). It must contain no theme tag at all — no naming '
      + 'of the speed/quality pattern back at them, however gently. Also worth reading: the select '
      + "receipt's `reason`. `mode` means the mode gate itself did the work, which is what this item is "
      + 'about; `turn_gate` / `no_eligible` / `empty` mean a cheaper gate got there first and the mode '
      + 'gate was never actually exercised — a pass, but not the pass this item was written for.',
  },
];

// The select reasons a genuinely quiet turn is expected to give. Anything else that is not an
// `offered_*` is still a non-offer and still passes — it just means a different gate did the work, so
// it is reported as a WARN rather than counted against the round. (An `awaiting_outcome`, for
// instance, is a perfectly healthy quiet: something is already in flight.)
const QUIET_REASONS: ReadonlyArray<ThreadSelectReport['reason']> = ['empty', 'no_eligible', 'turn_gate'];

/** Harvest results that MINTED something new. th-n1's second half: a greeting minting a loop or a
 *  theme is the capture side over-reading an empty turn. */
const MINTING_NOTES: ReadonlyArray<ThreadHarvestReport['note']> = ['minted', 'loop_minted'];

// ── Timing ──────────────────────────────────────────────────────────────────────────────────────
// loopBattery's defaults and loopBattery's reasoning: the env overrides exist so the harness itself
// can be smoke-tested against a stub in seconds, and must never be set for a real round.
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const STAGGER_MS = num('THREAD_STAGGER_MS', 20_000);  // one item every ~20 s, so turns don't batch
const SILENT_MS = num('THREAD_SILENT_MS', 90_000);    // past this a reply is LATE; no reply at all is SILENT
const SETTLE_MS = num('THREAD_SETTLE_MS', 180_000);   // grace after the LAST send
// A seeded item's two messages are one conversation, not two probes. The gap has to outlast the seed
// turn's whole round trip INCLUDING its fire-and-forget harvest, because the state the probe is being
// judged against — a minted theme, an incremented turn counter — only exists once that harvest lands.
// Longer than SILENT_MS on purpose: a seed that was merely LATE has still finished by the time the
// probe goes out.
const SEED_GAP_MS = num('THREAD_SEED_GAP_MS', 120_000);

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE = `threadBattery — one live round of conversational-threading negative controls.

  npx tsx scripts/convergence/threadBattery.ts --round N [options]

  --round N        round number; also names the clientIds (thr-rN-1 … thr-rN-${BATTERY.length}). Required.
  --base URL       instance base URL            (default http://127.0.0.1:3000)
  --db PATH        irises sqlite file           (default ~/.irises/irises.db)
  --out PATH       JSON results                 (default ./thread-round-N.json)
  --token TOKEN    DEBUG_TOKEN, if the instance sets one (env DEBUG_TOKEN is used otherwise)
  --handle H       memory handle the inventory is keyed by (default ${WEB_DEBUG_HANDLE})
  --reset-threads  DELETE the handle's thread_inventory row before the round (see below)
  --no-reset       skip the memory_short freshness reset
  --dry-run        print the plan and exit 0 — sends nothing
  --help           print this and exit 0 — sends nothing

Every web client shares ONE memory handle and thread_inventory is keyed by it, so these ${BATTERY.length} items run
against ONE shared inventory. Two things follow.

  • The round is worth most run WARM — against whatever the hand-run transcript built. An empty
    inventory passes every item with reason 'empty' and proves nothing, so --reset-threads is opt-in
    (the inverse of the memory_short reset, which stays default-on). The pre-round inventory summary
    is printed and written to the JSON: read it before believing a clean round.
  • --reset-threads is destructive to accreted state for that handle. The row is snapshotted into the
    JSON before it is deleted, but it is not restored. Use it to prove an item can pass cold, never as
    routine hygiene.

Verdicts:
  PASS            the receipts say the turn stayed quiet (and, where an item has one, a human still
                  has the reply to read — see the hand-read pointers under the table)
  SILENT          no assistant row at all — a real message answered with nothing
  THREAD_LEAK     a threads:select receipt reporting offered_loop / offered_theme on a turn that must
                  not surface anything
  HARVEST_LEAK    a threads:harvest receipt minting a theme or a loop out of a greeting
  MINT_INFLATION  a theme minted on this turn came back taggable or shorthand, or with more than one
                  evidence day — the two-distinct-days clock jumped
  LATE            answered after the ${SILENT_MS / 1000}s SLA. Reported, never failing: provider latency under this
                  battery's own stagger is not a threading defect, and a late reply is scored for
                  every leak exactly like an on-time one
  WARN            a quiet turn, but quiet for a reason outside the ones the item was written to
                  exercise (its own quietReasons; default {${QUIET_REASONS.join(', ')}}) — a
                  cheaper gate got there first. Reported, not failing, but a round of nothing but
                  WARNs is a round that never reached the gates it claims to test
  UNSCORED        the machine could not read this item honestly (no receipt, rolled trace buffer,
                  unreadable row). NOT a pass — the round is inconclusive rather than clean

Exit code: 0 clean · 1 failures · 3 inconclusive (no failures, but at least one UNSCORED) · 2 fatal.

NOTE: rebuild and restart the instance from this tree first, with CONVO_THREADING_ENABLED=true. A
round with no threads:select receipts anywhere is what a disabled flag looks like from out here, and
is reported as inconclusive rather than clean.`;

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
 * One statement through the sqlite3 CLI, parsed as the single JSON value it returns. The query wraps
 * its own rows in json_group_array/json_object: `-json` output is not available on every sqlite3
 * build, but the JSON1 functions are, so the SQL does the encoding instead of the CLI.
 */
function sqlJson<T>(db: string, sql: string): T[] {
  const raw = sh('sqlite3', [db, sql]);
  if (!raw || raw === 'null') return [];
  return JSON.parse(raw) as T[];
}

function sqlExec(db: string, sql: string): void {
  sh('sqlite3', [db, sql]);
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ── Types read back from the instance ───────────────────────────────────────────────────────────

interface Row { chatId: string; role: string; content: string; at: number }

/** The trace shape as the debug API serves it. `detail` is what this harness lives on: the two
 *  threading receipts put their whole report in there. */
interface TraceEvent {
  id: number; ts: number; type: string;
  chatId?: string; handle?: string; label?: string;
  detail?: Record<string, unknown>;
}

/** A `threads:select` detail: the report, plus the offer fields present only on an offer. The type
 *  import is the pin — if ThreadSelectReport's `reason` union gains or loses a value, this file stops
 *  compiling in an editor rather than quietly scoring a reason it has never heard of as a pass. */
type SelectDetail = ThreadSelectReport & {
  material?: string; rungCeiling?: string; label?: string; id?: string;
  outcomeAsk?: string | null;
};
type HarvestDetail = ThreadHarvestReport & { saved?: boolean };

/**
 * The debug API serves `detail` as an open record, so reading a receipt is a cast and there is no
 * pretending otherwise — it routes through `unknown` deliberately rather than hiding behind a
 * structural claim TypeScript would have to guess at. The type imports above are the CONTRACT (a
 * renamed field stops this file compiling), not a validation of the wire; the scoring code below
 * treats every field it reads as optional-in-practice for exactly that reason.
 */
function detailAs<T>(e: TraceEvent | undefined): T | null {
  return e?.detail ? (e.detail as unknown as T) : null;
}

/**
 * The parsed inventory row. The four json columns are read as TEXT and parsed INDEPENDENTLY here,
 * mirroring the repository's own discipline: one malformed column must not cost the other three, and
 * a harness that throws on a bad row would report a code failure that is really a parse failure.
 */
interface Inventory {
  handle: string;
  themes: ThreadTheme[];
  loops: OpenLoop[];
  turnsSinceOffer: number;
  harvestCount: number;
  updatedAt: number;
}

interface RawInventoryRow {
  handle: string; themes: string; loops: string;
  turnsSinceOffer: number; harvestCount: number; updatedAt: number;
}

/**
 * ABSENT and UNREADABLE are kept apart deliberately. "No row for this handle" is the honest resting
 * state of a handle that has never harvested anything, and it makes every negative control below pass
 * vacuously. "The query failed" (an unmigrated DB, a wrong --db path, a locked file) looks identical
 * from a `null` return and means the exact opposite: nothing was verified. Collapsing the two is how
 * a round against the wrong database reports itself as clean.
 */
interface InventoryRead { inv: Inventory | null; error: string | null }

function readInventory(db: string, handle: string): InventoryRead {
  let raw: RawInventoryRow[];
  try {
    raw = sqlJson<RawInventoryRow>(db, `SELECT json_group_array(json_object(
      'handle', handle, 'themes', themes_json, 'loops', loops_json,
      'turnsSinceOffer', turns_since_offer, 'harvestCount', harvest_count, 'updatedAt', updated_at))
      FROM thread_inventory WHERE handle = ${quote(handle)};`);
  } catch (err) {
    return { inv: null, error: (err as Error).message.split('\n').filter(Boolean).pop() ?? 'sqlite3 failed' };
  }
  if (!raw.length) return { inv: null, error: null };
  const r = raw[0];
  const parse = <T>(s: string): T[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch { return []; }
  };
  return {
    inv: {
      handle: r.handle,
      themes: parse<ThreadTheme>(r.themes),
      loops: parse<OpenLoop>(r.loops),
      turnsSinceOffer: r.turnsSinceOffer,
      harvestCount: r.harvestCount,
      updatedAt: r.updatedAt,
    },
    error: null,
  };
}

/** One line a reader can weigh a clean round against: an inventory with nothing surfaceable in it had
 *  nothing to leak, and every PASS below is then a statement about an empty room. */
function summarize(read: InventoryRead): string {
  if (read.error) return `UNREADABLE (${read.error}) — nothing below was verified against the row`;
  const inv = read.inv;
  if (!inv) return 'no row (empty inventory — every negative control passes vacuously)';
  const by = (s: string) => inv.themes.filter(t => t.status === s).length;
  const surfaceable = by('taggable') + by('shorthand');
  const openLoops = inv.loops.filter(l => l.status === 'open').length;
  return `${inv.themes.length} themes (open ${by('open')}, taggable ${by('taggable')}, shorthand ${by('shorthand')}, `
    + `sore ${by('sore')}, retired ${by('retired')}) · ${inv.loops.length} loops (open ${openLoops}) · `
    + `turnsSinceOffer ${inv.turnsSinceOffer} · harvestCount ${inv.harvestCount}`
    + (surfaceable === 0 && openLoops === 0 ? ' — NOTHING SURFACEABLE: this round cannot catch a leak' : '');
}

/**
 * A pointer, never a verdict. These patterns are the SHAPE of a how-did-it-go callback, and they are
 * matched only so a reader's eye lands on the right reply first — the engine's own answer to "did a
 * loop surface" is the threads:select receipt, and no regex is allowed to overrule it. A hit here on
 * a turn whose receipt says nothing was offered means she asked a question out of her own head, which
 * is not this feature and not a failure.
 */
const CALLBACK_SHAPES: RegExp[] = [
  /how (?:did|'d) .{0,48}\bgo\b/i,
  /how (?:is|are|was|were|did) .{0,32}(?:going|coming along|turn out|work out)/i,
  /\bany (?:news|word|update) (?:on|about)\b/i,
  /\b(?:you|u) (?:said|mentioned|told me) .{0,60}\?/i,
  /\bhow'?s (?:the|your) .{0,32}(?:going|coming)/i,
];
function sniffCallback(reply: string): string[] {
  return CALLBACK_SHAPES.filter(re => re.test(reply)).map(re => re.source);
}

// ── The round ───────────────────────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'SILENT' | 'THREAD_LEAK' | 'HARVEST_LEAK' | 'MINT_INFLATION' | 'LATE' | 'WARN' | 'UNSCORED';
const FAILING: Verdict[] = ['SILENT', 'THREAD_LEAK', 'HARVEST_LEAK', 'MINT_INFLATION'];

interface Result {
  id: string; ask: string; seed?: string; why: string; expect: ThreadExpect;
  clientId: string; chatId: string; sentAt: number; seedSentAt?: number;
  verdict: Verdict; evidence: string;
  /** Every check this item ran, in order, with what it saw. A failed round explains itself here. */
  checks: string[];
  reply: string | null; replyAt: number | null;
  select: SelectDetail | null;
  harvests: HarvestDetail[];
  /** The seed turn's receipts, when there is a seed. Not scored — it is the setup, and reading it is
   *  how you tell "the gate held" apart from "there was nothing to gate". */
  seedHarvests?: HarvestDetail[];
  /** Themes the harvest receipts say this turn MINTED, as they stand in the row at the end of the
   *  round. Attribution is by receipt id, never by timestamp — turns overlap under the stagger. */
  mintedThemes?: Array<Pick<ThreadTheme, 'id' | 'label' | 'status' | 'evidenceCount' | 'confidence'> & { evidenceDays: number }>;
  /** Non-verdict pointer: callback-shaped phrasings in the reply, for the human's eye only. */
  callbackSniff?: string[];
  handRead?: string;
  /** Items with a hand-read half get their whole reply, never clipped — the loopBattery precedent. */
  fullReply?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
/** Markdown cells: pipes break the table and newlines break the row. */
const cell = (s: string) => truncate(s.replace(/\s*\n+\s*/g, ' ⏎ ').replace(/\|/g, '\\|'), 64);

async function main(): Promise<number> {
  if (flag('help') || flag('h') || process.argv.length <= 2) { console.log(USAGE); return 0; }

  const round = arg('round');
  if (!round || !/^\d+$/.test(round)) { console.error('error: --round N is required (integer)\n\n' + USAGE); return 2; }

  const base = (arg('base', 'http://127.0.0.1:3000') as string).replace(/\/+$/, '');
  const db = expand(arg('db', '~/.irises/irises.db') as string);
  const out = expand(arg('out', `./thread-round-${round}.json`) as string);
  const handle = arg('handle', WEB_DEBUG_HANDLE) as string;
  const token = arg('token', process.env.DEBUG_TOKEN);
  const q = token ? `?token=${encodeURIComponent(token)}` : '';

  // clientId is positional (`thr-r3-4`), not the item's mnemonic id: the round's lanes must be fresh
  // and predictable from the round number alone. The mnemonic id stays on the report row.
  const plan = BATTERY.map((item, i) => {
    const clientId = `thr-r${round}-${i + 1}`;
    return { ...item, clientId, chatId: webChatId(clientId) };
  });

  if (flag('dry-run')) {
    console.log(`# Thread round ${round} — dry run (nothing sent)\n`);
    console.log('| id | expect | clientId | chatId | seed | ask |');
    console.log('|----|--------|----------|--------|------|-----|');
    for (const p of plan) console.log(`| ${p.id} | ${p.expect} | ${p.clientId} | ${p.chatId} | ${p.seed ? cell(p.seed) : '—'} | ${cell(p.ask)} |`);
    const seeds = plan.filter(p => p.seed).length;
    console.log(`\n${plan.length} items (${seeds} seeded) · stagger ${STAGGER_MS / 1000}s · seed gap ${SEED_GAP_MS / 1000}s · settle ${SETTLE_MS / 1000}s`);
    console.log(`db ${db} · base ${base} · handle ${handle}`);
    console.log(`\npre-round inventory: ${summarize(readInventory(db, handle))}`);
    console.log('(a dry run reads the row but sends nothing — this line is what a real round would be measured against)');
    return 0;
  }

  // 1. Snapshot the inventory BEFORE anything is sent. It is the round's evidence-strength statement,
  //    and — when --reset-threads is used — the only copy of what was deleted.
  const readBefore = readInventory(db, handle);
  const invBefore = readBefore.inv;
  console.error(`[thr] pre-round inventory: ${summarize(readBefore)}`);
  if (readBefore.error) {
    console.error('[thr] the inventory row could not be read — check --db. th-n4 will go UNSCORED rather than pass.');
  }

  // 2. Freshness reset, loopBattery's reasoning verbatim: web clients share one memory handle, so a
  //    cached research row from an earlier item changes how a later one is routed. Threading does not
  //    read memory_short, but these turns still run the whole pipeline and a surprise delegation is a
  //    surprise turn.
  if (flag('no-reset')) {
    console.error('[thr] memory_short reset SKIPPED (--no-reset)');
  } else {
    try {
      sqlExec(db, `DELETE FROM memory_short WHERE agent_handle = ${quote(handle)};`);
      console.error(`[thr] reset memory_short for ${handle}`);
    } catch (err) {
      console.error(`[thr] freshness reset FAILED (${(err as Error).message.split('\n')[0]}) — continuing`);
    }
  }

  // 3. The inventory reset is OPT-IN and loud. Snapshotted above, deleted here, never restored.
  if (flag('reset-threads')) {
    try {
      sqlExec(db, `DELETE FROM thread_inventory WHERE handle = ${quote(handle)};`);
      console.error(`[thr] DELETED thread_inventory row for ${handle} — this round runs COLD, and every `
        + 'item will pass on an empty inventory whether or not the code is right. The deleted row is in the JSON.');
    } catch (err) {
      console.error(`[thr] thread reset FAILED (${(err as Error).message.split('\n')[0]}) — continuing warm`);
    }
  }

  // 4. Trace snapshot. Only events NEWER than this can belong to the round.
  const before = curlJson<{ events: TraceEvent[] }>(`${base}/debug/api/traces${q}`);
  const traceFloor = before?.events?.length ? Math.max(...before.events.map(e => e.id)) : 0;
  if (!before) {
    // Unlike loopBattery there is no log fallback: `threads:select` and `threads:harvest` exist only
    // in the ring buffer, so an unreachable trace API means the round cannot be scored at all.
    console.error('[thr] trace buffer UNREACHABLE — the threading receipts have no other source; '
      + 'this round will be INCONCLUSIVE. Check --base and --token before spending the turns.');
  }

  // 5. Send.
  const started = Date.now();
  const sentAt = new Map<string, number>();
  const seedSentAt = new Map<string, number>();
  for (const [i, p] of plan.entries()) {
    if (i > 0) await sleep(STAGGER_MS);
    const post = (text: string) => {
      const payload = JSON.stringify({ text, clientId: p.clientId });
      sh('curl', ['-sS', '--max-time', '30', '-X', 'POST', `${base}/api/web/message${q}`,
        '-H', 'Content-Type: application/json', '-d', payload]);
    };
    try {
      if (p.seed) {
        seedSentAt.set(p.id, Date.now());
        post(p.seed);
        console.error(`[thr] ${i + 1}/${plan.length} seeded ${p.id} (${p.chatId}) — ${truncate(p.seed, 44)}`);
        // The probe is only meaningful once the seed's harvest has landed in the row.
        await sleep(SEED_GAP_MS);
      }
      // Stamped BEFORE the call: the silent window is measured from the send, and a reply can be
      // persisted before curl's 202 even unwinds.
      sentAt.set(p.id, Date.now());
      post(p.ask);
      console.error(`[thr] ${i + 1}/${plan.length} sent ${p.id} (${p.chatId}) — ${truncate(p.ask, 44)}`);
    } catch (err) {
      console.error(`[thr] ${p.id} SEND FAILED: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  // 6. Settle, then read everything back at once.
  console.error(`[thr] all sent; settling ${SETTLE_MS / 1000}s`);
  await sleep(SETTLE_MS);

  const chatIds = plan.map(p => quote(p.chatId)).join(',');
  let rows: Row[] = [];
  try {
    rows = sqlJson<Row>(db, `SELECT json_group_array(json_object('chatId', chat_id, 'role', role, 'content', content, 'at', created_at))
      FROM messages WHERE chat_id IN (${chatIds}) AND created_at >= ${started - 60_000};`)
      .sort((a, b) => a.at - b.at);
  } catch (err) {
    console.error(`[thr] could not read ${db}: ${(err as Error).message.split('\n')[0]}`);
    return 2;
  }

  const after = curlJson<{ events: TraceEvent[] }>(`${base}/debug/api/traces${q}`);
  const afterEvents = after?.events ?? [];
  const fresh = afterEvents.filter(e => e.id > traceFloor);
  // The ring buffer holds ~500 events and a five-item round with seeds is not cheap, so it can roll
  // PAST the snapshot mid-round. It did exactly that iff the oldest event still visible is newer than
  // the one right after the snapshot — then some of the round's own receipts were evicted, and "no
  // offer receipt" would be a claim the evidence does not support. Everything goes UNSCORED.
  const oldestVisible = afterEvents.length ? Math.min(...afterEvents.map(e => e.id)) : Infinity;
  const tracesUsable = afterEvents.length > 0 && oldestVisible <= traceFloor + 1;
  // A round where the feature never once reported in is a round against an instance that is not
  // running it — a disabled flag, an old binary, a group handle. Not clean, and not a code failure
  // either: it is the harness saying it measured nothing.
  const anySelect = fresh.some(e => e.label === 'threads:select');

  const readAfter = readInventory(db, handle);
  const invAfter = readAfter.inv;

  // 7. Verdicts.
  const anomalies: string[] = [];
  const results: Result[] = plan.map(p => {
    const t0 = sentAt.get(p.id) ?? started;
    const seed0 = seedSentAt.get(p.id);
    const mine = rows.filter(r => r.chatId === p.chatId);
    // The chatId is fresh for this round, so anything assistant-shaped in it belongs to this item; the
    // timestamp floor separates the PROBE turn from its own seed turn, which is the whole reason a
    // seeded item can be scored at all.
    const answers = mine.filter(r => r.role === 'assistant' && r.at >= t0 - 1_000);
    const reply = answers.length ? answers.map(r => r.content).join('\n') : null;
    const lateBy = answers.length ? Math.round((answers[0].at - t0) / 1000) : 0;
    const late = answers.length > 0 && answers[0].at > t0 + SILENT_MS;

    // Receipts, split by the same floor. `threads:select` runs once per turn, before the reply.
    const mineEvents = fresh.filter(e => e.chatId === p.chatId);
    const selects = mineEvents.filter(e => e.label === 'threads:select' && e.ts >= t0 - 1_000);
    const select = detailAs<SelectDetail>(selects[0]);
    const readHarvests = (from: number, to: number) => mineEvents
      .filter(e => e.label === 'threads:harvest' && e.ts >= from && e.ts < to)
      .map(e => detailAs<HarvestDetail>(e))
      .filter((d): d is HarvestDetail => d !== null);
    const harvests = readHarvests(t0 - 1_000, Infinity);
    const seedHarvests = seed0 === undefined ? undefined : readHarvests(seed0 - 1_000, t0 - 1_000);

    // Themes this turn's receipts say were MINTED, looked up in the end-of-round row. Attribution runs
    // through the receipt's own themeId — never a timestamp window, because a 20 s stagger overlaps
    // turns and a window would be guessing which turn a row change belongs to.
    const mintedIds = harvests.filter(h => h.note === 'minted' && h.themeId).map(h => h.themeId as string);
    const mintedThemes = mintedIds.map(id => {
      const t = invAfter?.themes.find(x => x.id === id);
      return t
        ? { id: t.id, label: t.label, status: t.status, evidenceCount: t.evidenceCount, confidence: t.confidence, evidenceDays: t.evidenceDays.length }
        : { id, label: '(evicted or unreadable)', status: 'gone' as ThreadTheme['status'], evidenceCount: 0, confidence: 0, evidenceDays: 0 };
    });

    const checks: string[] = [];
    let verdict: Verdict = 'PASS';
    let evidence = truncate(reply ?? '', 150);

    if (!answers.length) {
      verdict = 'SILENT';
      evidence = `no assistant row at all for ${p.chatId}`;
      checks.push('reply: NONE');
    } else {
      checks.push(`reply: +${lateBy}s, ${reply?.length ?? 0} chars`);

      // Scoreability first. A verdict the evidence cannot support is not a verdict.
      const unscorable =
        !tracesUsable ? 'trace buffer rolled past the round — receipts incomplete'
        : !select ? 'no threads:select receipt for this chat (flag off? group handle? read path never ran?)'
        : p.expect === 'no_promote' && readAfter.error ? `inventory row unreadable (${readAfter.error}) — the arithmetic cannot be checked`
        : p.expect === 'no_promote' && mintedIds.length && !invAfter ? 'harvest minted a theme but no inventory row came back — the mint cannot be inspected'
        : null;

      if (unscorable) {
        verdict = 'UNSCORED';
        evidence = unscorable;
        checks.push(`scoreable: NO — ${unscorable}`);
      } else {
        const sel = select as SelectDetail;
        checks.push(`select: ${sel.reason} (turnsSinceOffer ${sel.turnsSinceOffer}, offers24h ${sel.offersLast24h})`);
        checks.push(`harvest: ${harvests.length ? harvests.map(h => `${h.note}/${h.outcome}${h.saved === false ? ' (NOT SAVED)' : ''}`).join(', ') : 'none (bare tick)'}`);

        const offered = sel.reason.startsWith('offered_');

        if (offered && p.expect !== 'no_promote') {
          // The one never-event this whole file exists for.
          verdict = 'THREAD_LEAK';
          evidence = `${sel.reason} — ${sel.material} "${sel.label}" at the ${sel.rungCeiling} rung — ${truncate(reply ?? '', 90)}`;
        } else if (p.expect === 'quiet' && harvests.some(h => MINTING_NOTES.includes(h.note))) {
          const minted = harvests.filter(h => MINTING_NOTES.includes(h.note));
          verdict = 'HARVEST_LEAK';
          evidence = `a greeting minted ${minted.map(h => `${h.note} "${h.label}"`).join(', ')}`;
        } else if (p.expect === 'no_promote' && mintedThemes.some(t => t.status === 'taggable' || t.status === 'shorthand' || t.evidenceDays > 1)) {
          const bad = mintedThemes.filter(t => t.status === 'taggable' || t.status === 'shorthand' || t.evidenceDays > 1);
          verdict = 'MINT_INFLATION';
          evidence = `minted this turn and already ${bad.map(t => `${t.status} (${t.evidenceDays} evidence day(s), conf ${t.confidence}) "${t.label}"`).join('; ')}`;
        } else if (offered) {
          // no_promote items are about the arithmetic, not the airtime: an offer here is a fact about
          // the round worth seeing, not a failure of the thing this item measures.
          verdict = 'WARN';
          evidence = `${sel.reason} on a no_promote item (not scored against it) — ${truncate(reply ?? '', 90)}`;
        } else if (late) {
          verdict = 'LATE';
          evidence = `first reply +${lateBy}s (SLA ${SILENT_MS / 1000}s), quiet as expected (${sel.reason})`;
        } else if (p.expect !== 'no_promote' && !(p.quietReasons ?? QUIET_REASONS).includes(sel.reason)) {
          verdict = 'WARN';
          evidence = `quiet, but via '${sel.reason}' — this item is about {${(p.quietReasons ?? QUIET_REASONS).join(', ')}}, so a cheaper gate got there first`;
        } else {
          evidence = `${sel.reason}${mintedThemes.length ? ` · minted ${mintedThemes.map(t => `"${t.label}" ${t.status}/${t.evidenceDays}d`).join(', ')}` : ''} — ${evidence}`;
        }
      }
    }

    const callbackSniff = reply ? sniffCallback(reply) : [];

    return {
      id: p.id, ask: p.ask, ...(p.seed ? { seed: p.seed } : {}), why: p.why, expect: p.expect,
      clientId: p.clientId, chatId: p.chatId, sentAt: t0, ...(seed0 !== undefined ? { seedSentAt: seed0 } : {}),
      verdict, evidence, checks,
      reply, replyAt: answers.length ? answers[0].at : null,
      select, harvests,
      ...(seedHarvests ? { seedHarvests } : {}),
      ...(mintedThemes.length ? { mintedThemes } : {}),
      ...(callbackSniff.length ? { callbackSniff } : {}),
      ...(p.handRead ? { handRead: p.handRead, fullReply: reply ?? '' } : {}),
    };
  });

  // 8. Round-level anomalies — true things worth a reader's attention that belong to no single item,
  //    so they are scored against none of them. A theme first seen inside this round that is already
  //    past `open` would mean the two-distinct-days clock jumped; but a round can legitimately
  //    straddle a UTC midnight, and the harness will not accuse the engine of a bug it cannot rule
  //    out from here. Reported, never a verdict — th-n4's MINT_INFLATION is the check that IS scored,
  //    and it is scored off the harvest receipt's own themeId rather than off a timestamp.
  for (const t of invAfter?.themes ?? []) {
    if (t.firstSeenAt >= started && t.status !== 'open') {
      anomalies.push(`theme "${t.label}" (${t.id}) was first seen during this round and is already ${t.status} — `
        + 'check whether the round crossed a UTC midnight before reading this as a defect');
    }
  }

  // 9. Report.
  const failures = results.filter(r => FAILING.includes(r.verdict));
  const unscored = results.filter(r => r.verdict === 'UNSCORED');
  const warns = results.filter(r => r.verdict === 'WARN');
  const lates = results.filter(r => r.verdict === 'LATE');
  const handReads = results.filter(r => r.handRead);
  const clean = failures.length === 0 && unscored.length === 0 && anySelect;

  const headline = failures.length ? `${failures.length} FAILURE(S)`
    : !anySelect ? 'INCONCLUSIVE — no threads:select receipt anywhere'
    : unscored.length ? `INCONCLUSIVE — ${unscored.length} unscored`
    : 'CLEAN';
  console.log(`\n# Thread round ${round} — ${headline}${lates.length ? ` · ${lates.length} LATE` : ''}\n`);
  console.log(`inventory before: ${summarize(readBefore)}`);
  console.log(`inventory after:  ${summarize(readAfter)}\n`);
  console.log('| id | expect | ask | verdict | select | evidence |');
  console.log('|----|--------|-----|---------|--------|----------|');
  for (const r of results) {
    console.log(`| ${r.id} | ${r.expect} | ${cell(r.ask)} | ${r.verdict} | ${r.select?.reason ?? '—'} | ${cell(r.evidence)} |`);
  }
  console.log('');
  const tally = (v: Verdict) => results.filter(r => r.verdict === v).length;
  console.log(`${results.length} items · PASS ${tally('PASS')} · LATE ${lates.length} · SILENT ${tally('SILENT')}`
    + ` · THREAD_LEAK ${tally('THREAD_LEAK')} · HARVEST_LEAK ${tally('HARVEST_LEAK')}`
    + ` · MINT_INFLATION ${tally('MINT_INFLATION')} · WARN ${warns.length} · UNSCORED ${unscored.length}`);
  if (lates.length) console.log(`late past the ${SILENT_MS / 1000}s SLA but answered (not counted against the round): ${lates.map(r => r.id).join(', ')}`);
  if (!anySelect) console.log('NO threads:select receipts at all — the instance on --base is not running threading (flag off, or an old binary). Nothing here was measured.');
  if (handReads.length) {
    console.log('\nstill to read by hand (fullReply in the JSON — the receipts only cover half these items):');
    for (const r of handReads) console.log(`  ${r.id}: ${r.handRead}`);
  }
  if (anomalies.length) {
    console.log('\nanomalies (reported, not scored):');
    for (const a of [...new Set(anomalies)]) console.log(`  · ${a}`);
  }
  console.log(`\nevidence: traces ${tracesUsable ? `usable (${fresh.length} new events)` : 'INCOMPLETE — buffer rolled'}, `
    + `inventory row ${invAfter ? 'read' : 'absent'}`);

  writeFileSync(out, JSON.stringify({
    round: Number(round), base, db, handle,
    startedAt: started, finishedAt: Date.now(),
    items: results.length, tracesUsable, traceFloor, anySelect, clean,
    // Verbatim, both ends. When --reset-threads was used, `inventoryBefore` is the only copy of the
    // row that was deleted.
    inventoryBefore: invBefore, inventoryAfter: invAfter,
    inventoryReadError: readBefore.error ?? readAfter.error ?? null,
    resetThreads: flag('reset-threads'),
    counts: {
      pass: tally('PASS'), late: lates.length, silent: tally('SILENT'),
      threadLeak: tally('THREAD_LEAK'), harvestLeak: tally('HARVEST_LEAK'),
      mintInflation: tally('MINT_INFLATION'), warn: warns.length, unscored: unscored.length,
    },
    anomalies: [...new Set(anomalies)],
    results,
  }, null, 2) + '\n');
  console.log(`json: ${out}`);

  // 0 clean · 1 failures · 3 inconclusive. The third code exists so a driver script can tell "the
  // code is wrong" apart from "nothing was measured" without parsing the JSON — they need opposite
  // responses, and collapsing them into one non-zero exit is how an unmeasured round gets retried
  // forever as if it were a bug.
  if (failures.length) return 1;
  return clean ? 0 : 3;
}

main().then(code => { process.exitCode = code; }, err => {
  console.error('[thr] fatal', err);
  process.exitCode = 2;
});
