// The important-note groomer: an async, throttled pass that folds near-DUPLICATE notes into one.
//
// Why it exists: notes ("remember this") are capped at MAX_ACTIVE_NOTES and evicted FIFO, and they
// render VERBATIM into every turn. A user who restates the same fact three times over a month spends
// three of those twenty slots on one fact and ages out three older, distinct ones. The groomer buys
// those slots back.
//
// Doctrine, all of it borrowed from the dossier updater (dossier.ts) and Ops triage (triage.ts):
//   • The LLM is a SUGGESTER. Every cluster it proposes is re-validated here against the real notes
//     — indices, disjointness, confidence, length, and literal preservation — and a cluster that
//     fails any check is dropped without dropping the rest of the plan.
//   • A truncated reply is MANGLED, not shorter (a cut-off JSON plan parses to something arbitrary),
//     so it is rejected wholesale.
//   • Failure is a total no-op and NEVER user-visible: no lane, no budget, a thrown write — every
//     path returns a GroomResult with a `skipped` reason and mutates nothing.
//   • The note bodies are USER-AUTHORED, so they ride into the prompt inside wrapPrompt/dataTag.
//
// Locking: this module must NEVER take withHandleLock (it isn't re-entrant, and mergeNotes takes it
// itself — a deadlock). That is also why the /forget fence is passed IN as a value: the epoch is read
// here, outside any lock, and checked inside mergeNotes' locked section.

import { jsonrepair } from 'jsonrepair';
import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { listMediumActive, mergeNotes, MERGED_NOTE_MAX_CHARS, type MediumEntry } from '../db/repositories/memoryMedium.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';

/** At most one groom per handle per this window. Same shape as the dossier's throttle: the check
 *  and the stamp happen together, so a burst of saved notes still costs one pass. */
export const GROOM_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** The window actually enforced (env: NOTE_GROOM_THROTTLE_MS), read at CALL time like every other
 *  memory knob. A non-numeric or non-positive value falls back to the default above rather than to
 *  "no throttle": a typo in this one must never put a classify call behind every saved note. */
function groomThrottleMs(): number {
  const n = Number(process.env.NOTE_GROOM_THROTTLE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GROOM_THROTTLE_MS;
}

const lastGroom = new Map<string, number>();

/** Below this many candidate notes the cap isn't under pressure and a merge is pure risk — the
 *  gate that keeps the common case (a handful of notes) from ever reaching a model. */
export const GROOM_MIN_ACTIVE_NOTES = 6;
/** Jaccard floor for "these two might be the same fact". */
export const GROOM_SIM_MIN = 0.34;
/** …OR containment (|A∩B| / min(|A|,|B|)) this high. Catches the short-note-inside-long-note shape
 *  Jaccard structurally misses: "gate code 4421" ⊂ "the gate code for the house is 4421, punch it
 *  in on the keypad…" scores badly on union but is a total containment. */
export const GROOM_CONTAINMENT_MIN = 0.6;
/** ANTI-LOOP: a note the groomer itself wrote is not a candidate for this long. Without it, a merge
 *  and its own sources' vocabulary keep re-qualifying and the tier is re-synthesized every cycle,
 *  drifting further from the user's words each time. */
export const GROOM_FREEZE_MS = 7 * 24 * 60 * 60 * 1000;
/** Blast radius of ONE run: at most this many merges, of at most this many notes each. */
export const MAX_CLUSTERS_PER_RUN = 3;
export const MAX_CLUSTER_SIZE = 5;
/** The plan is a small JSON object; this is generous for three clusters of merged text. */
const MERGE_MAX_TOKENS = 800;
/** Wall clock for the one model call, same bound Ops triage puts on its classify (triage.ts).
 *  Nothing awaits this groom, but a lane that never answers would pin the notes it read forever
 *  and merge them against a tier that has moved on. A timeout is just another 'llm_failed'. */
const MERGE_TIMEOUT_MS = 15_000;

/** Kill switch, read at CALL time so flipping it doesn't need a restart. Default ON. */
function noteGroomEnabled(): boolean {
  const v = (process.env.NOTE_GROOM_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

export interface GroomResult {
  merged: number;      // notes retired into merges
  clusters: number;    // merges applied
  // 'none'         — the model looked and found no duplicates ({"merges":[]}), the HEALTHY answer
  // 'rejected'     — it proposed merges and every one of them failed validation here or at the tier
  // 'write_failed' — the tier itself couldn't write (MediumWriteError); nothing about the plan
  // 'llm_failed'   — no lane, no budget, a throw, or the call timed out
  skipped: null | 'disabled' | 'throttled' | 'too_few' | 'no_candidates'
         | 'llm_failed' | 'truncated' | 'unparsable' | 'none' | 'rejected' | 'write_failed'
         | 'forgotten';
}

export interface MergeCluster {
  notes: number[];     // 1-based indices into the candidate list the model was shown
  merged: string;
  confidence: string;
}
export interface MergePlan {
  merges: MergeCluster[];
}

/** The groomer's contract with the model. Pinned character-for-character by noteGroomer.test.ts:
 *  every clause here is load-bearing (JSON-only, one fact per merge, newest wins, literals verbatim,
 *  synthesize-don't-concatenate, high confidence only). */
export const NOTE_MERGE_SYSTEM_PROMPT = `You curate the saved notes of a personal assistant's single user. You receive a numbered list of short notes the user explicitly asked to be remembered, numbered oldest to newest. Find notes that are duplicates — restatements, refinements, or updates of the SAME fact — and produce one merged replacement per duplicate group.

Reply with STRICT JSON only. No prose, no code fences, no explanation:
{"merges":[{"notes":[1,3],"merged":"<replacement note>","confidence":"high"}]}

Rules:
- {"merges":[]} is the normal answer. Merge only notes that clearly record the same fact.
- NEVER combine different facts into one note or into a list. A merge replaces duplicates of one fact; it never bundles.
- When two versions of a fact disagree, the newest note (highest number) wins. The replacement keeps only the current version.
- Keep literal values — codes, numbers, names, dates, addresses, exact spellings — character-for-character as written. Never round, reformat, or paraphrase them.
- Synthesize, do not concatenate. The replacement must be shorter than its sources combined, at most 600 characters, and reuse the user's own wording wherever possible.
- Set confidence to "high" only when the notes are unmistakably the same fact. If you are not certain, leave them out.`;

const MERGE_INSTRUCTIONS = 'Return the merge plan for the notes above as strict JSON, using the note numbers exactly as shown. {"merges":[]} when no two of them record the same fact.';

// Small and deliberately incomplete: these words carry no facts, so leaving them in makes every
// pair of English sentences look alike. Anything domain-bearing stays.
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'for',
  'in', 'on', 'at', 'it', 'its', 'this', 'that', 'with', 'my', 'me', 'i', 'you', 'your', 'they',
  'them', 'their', 'we', 'us', 'our', 'as', 'by', 'from', 'so', 'if', 'do', 'does', 'did',
]);

function tokenSet(body: string): Set<string> {
  return new Set(
    body.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t !== '' && !STOPWORDS.has(t)),
  );
}

/**
 * Which note pairs are plausibly the same fact — the cheap gate that decides whether an LLM call
 * happens at all. Pure, O(n²) over ≤ MAX_ACTIVE_NOTES tiny token sets. Deliberately LOOSE: a false
 * positive costs one model call that answers {"merges":[]}, a false negative costs a wasted slot
 * forever.
 */
export function similarityPairs(bodies: string[]): Array<[number, number]> {
  const sets = bodies.map(tokenSet);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (!a.size || !b.size) continue;
      let intersection = 0;
      for (const t of a) if (b.has(t)) intersection++;
      if (!intersection) continue;
      const jaccard = intersection / (a.size + b.size - intersection);
      const containment = intersection / Math.min(a.size, b.size);
      if (jaccard >= GROOM_SIM_MIN || containment >= GROOM_CONTAINMENT_MIN) pairs.push([i, j]);
    }
  }
  return pairs;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Model text → merge plan. The same ladder the bubble parser uses (outermost brace-delimited
 * candidate → parse → jsonrepair → parse), so a reply with a stray trailing comma or an unquoted
 * key still lands. Shape-checks only — the plan's CONTENT is validated against the real notes in
 * acceptClusters. Null means "nothing usable came back", which is a no-op upstream.
 */
export function parseMergePlan(text: string | null): MergePlan | null {
  if (!text) return null;
  const candidate = text.match(/\{[\s\S]*\}/);
  if (!candidate) return null;
  let parsed = tryParse(candidate[0]);
  if (parsed == null) {
    try {
      parsed = tryParse(jsonrepair(candidate[0]));
    } catch {
      return null; // jsonrepair throws on input it can't rescue
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = (parsed as { merges?: unknown }).merges;
  if (!Array.isArray(raw)) return null;
  const merges: MergeCluster[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const c = item as { notes?: unknown; merged?: unknown; confidence?: unknown };
    merges.push({
      notes: Array.isArray(c.notes) ? c.notes.filter((n): n is number => Number.isInteger(n)) : [],
      merged: typeof c.merged === 'string' ? c.merged : '',
      confidence: typeof c.confidence === 'string' ? c.confidence.trim().toLowerCase() : '',
    });
  }
  return { merges };
}

/** Every multi-digit run in a source must reappear in the merge. Codes, PINs, house numbers, years,
 *  amounts — a synthesis that drops one has lost the exact thing the note existed to hold, and the
 *  loss is invisible once the sources are retired. */
function keepsLiterals(sources: MediumEntry[], merged: string): boolean {
  for (const s of sources) {
    for (const literal of s.body.match(/\d{2,}/g) ?? []) {
      if (!merged.includes(literal)) return false;
    }
  }
  return true;
}

/**
 * Re-validate the model's plan against the notes it was actually shown. A bad cluster is DROPPED,
 * never the whole plan — one hallucinated index shouldn't cost the two good merges beside it.
 */
function acceptClusters(plan: MergePlan, candidates: MediumEntry[]): MergeCluster[] {
  const accepted: MergeCluster[] = [];
  const claimed = new Set<number>();
  for (const cluster of plan.merges) {
    if (accepted.length >= MAX_CLUSTERS_PER_RUN) break;
    const notes = [...new Set(cluster.notes)];
    if (notes.length < 2 || notes.length > MAX_CLUSTER_SIZE) continue;
    if (notes.some(n => n < 1 || n > candidates.length)) continue;
    // First cluster wins a contested note: applying both would merge a note that no longer exists.
    if (notes.some(n => claimed.has(n))) continue;
    if (cluster.confidence !== 'high') continue;
    const body = cluster.merged.trim();
    if (!body || body.length > MERGED_NOTE_MAX_CHARS) continue;
    const sources = notes.map(n => candidates[n - 1]);
    // A "merge" longer than what it replaces is a concatenation, and notes render verbatim every
    // turn — it would cost more context than the duplicates it removes.
    if (body.length > sources.reduce((sum, s) => sum + s.body.trim().length, 0)) continue;
    if (!keepsLiterals(sources, body)) continue;
    for (const n of notes) claimed.add(n);
    accepted.push({ ...cluster, notes, merged: body });
  }
  return accepted;
}

/** Reject `work` after `ms`. Same shape as Ops triage's own bound (agents/ops/triage.ts) —
 *  unref'd so a pending groom can never hold the process open. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('note groom timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** Test seam: clear the per-handle throttle so a test can run two grooms back to back. */
export function __resetGroomThrottleForTests(): void {
  lastGroom.clear();
}

/**
 * Fold near-duplicate important notes for one handle. Fire-and-forget from the reply path
 * (`void groomNotes(handle)`); never awaited, never surfaced.
 */
export async function groomNotes(
  handle: string,
  deps: { llm?: typeof callLLM; now?: () => number } = {},
): Promise<GroomResult> {
  const llm = deps.llm ?? callLLM;
  const now = deps.now ?? Date.now;
  const nothing = (skipped: GroomResult['skipped']): GroomResult => ({ merged: 0, clusters: 0, skipped });

  try {
    if (!noteGroomEnabled()) return nothing('disabled');
    const startedAt = now();
    if (startedAt - (lastGroom.get(handle) ?? 0) < groomThrottleMs()) return nothing('throttled');
    lastGroom.set(handle, startedAt);

    const notes = await listMediumActive(handle, ['important_note']); // oldest first
    const candidates = notes.filter(n => !(n.source === 'groomer' && startedAt - n.createdAt < GROOM_FREEZE_MS));
    if (candidates.length < GROOM_MIN_ACTIVE_NOTES) return nothing('too_few');
    if (!similarityPairs(candidates.map(n => n.body)).length) return nothing('no_candidates');

    // Read BEFORE the call and passed into every write below: a /forget that lands while the model
    // is thinking must not have its wipe undone by a merge that read the pre-forget notes. Read
    // here, outside any lock — mergeNotes checks it inside its own (see its header).
    const epoch0 = getForgetEpoch(handle);
    // 1..N in listMediumActive order (oldest → newest), so the prompt's "the newest note (highest
    // number) wins" is true of the list the model actually sees.
    const numbered = candidates.map((n, i) => `${i + 1}. ${n.body}`).join('\n');

    // Bounded: a hung lane rejects into the catch below, which is a silent, non-mutating no-op.
    const res = await withTimeout(
      llm({
        role: 'classify',
        maxTokens: MERGE_MAX_TOKENS,
        system: NOTE_MERGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: wrapPrompt(`${dataTag('active_notes', numbered)}\n\n${MERGE_INSTRUCTIONS}`) }],
        trace: { handle, label: 'memory:note_merge' },
      }),
      MERGE_TIMEOUT_MS,
    );
    // Same doctrine as the dossier rewrite: a cut-off JSON plan is MANGLED, not shorter — its last
    // cluster is a fragment of a synthesis that would retire real notes behind it.
    if (res.truncated) return nothing('truncated');

    const plan = parseMergePlan(res.text);
    if (!plan) return nothing('unparsable');
    // "It looked and found nothing" is the normal answer, and NOT the same event as "it proposed
    // merges and every one was thrown out" — conflating them hides a model that keeps failing
    // validation behind a reason that reads as healthy.
    if (!plan.merges.length) return nothing('none');
    const accepted = acceptClusters(plan, candidates);
    if (!accepted.length) return nothing('rejected');

    let clusters = 0;
    let merged = 0;
    let writeFailed = false;
    // Sequential, not Promise.all: they serialize on the handle lock anyway, and one at a time
    // means a failure is attributable to a specific cluster.
    for (const cluster of accepted) {
      const ids = cluster.notes.map(n => candidates[n - 1].id);
      let entry: MediumEntry | null = null;
      try {
        entry = await mergeNotes(handle, ids, cluster.merged, 'groomer', { ifForgetEpoch: epoch0 });
      } catch (err) {
        // A MediumWriteError is the tier failing to write at all, not this cluster being bad —
        // stop rather than retry the same failing write two more times.
        console.warn(`[memory] note merge write failed for ${handle} — stopping this groom`, err);
        writeFailed = true;
        break;
      }
      if (!entry) {
        console.warn(`[memory] note merge rejected by the tier for ${handle} (${ids.length} notes) — skipping the cluster`);
        continue;
      }
      clusters++;
      merged += ids.length;
    }
    if (!clusters) {
      // The tier failing to write says nothing about the plan — keep it out of 'rejected'.
      if (writeFailed) return nothing('write_failed');
      return nothing(getForgetEpoch(handle) !== epoch0 ? 'forgotten' : 'rejected');
    }

    record({ type: 'event', label: 'memory:notes_merged', handle, detail: { clusters, merged } });
    return { merged, clusters, skipped: null };
  } catch (err) {
    // No lane configured, budget exhausted, a timeout, a parse blowup — all the same to the user,
    // who never sees this run at all. Which is exactly why it is REPORTED as well as logged: a
    // silent background pass that has been failing for a week looks identical, from the outside, to
    // one that keeps finding nothing to merge. Same category and severity the climate eval uses
    // (memory/climateDrift.ts) so the two background classify passes read alike on the Errors tab,
    // and errorLog's fingerprint folding keeps a persistently dead lane at one row.
    console.warn(`[memory] note groom failed for ${handle}`, err);
    reportError({
      source: 'memory',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'note groom failed — no notes merged',
      err,
      handle,
    });
    return nothing('llm_failed');
  }
}
