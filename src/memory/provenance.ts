// WHO SAYS SO. Every durable fact about the user arrived one of three ways, and the difference is
// the difference between "you told me" and "I worked it out" — the second of which she must hold
// loosely enough to be corrected without an argument.
//
//   stated   — they said it, in their own words, in a message she read.
//   seeded   — it came from the engine she fronts, handed over at install. Second-hand about a
//              person she had never spoken to (memory/seedFromEngine.ts).
//   inferred — she deduced it. Useful, and the thing she must never cite as testimony.
//
// The rank order is the whole safety property: `promote` takes the max, so a fact can only ever get
// STRONGER. Their own words replace a guess; a guess never unseats their words.
//
// WHERE IT IS STORED. Two stores, two grammars, NO schema change in either:
//   • `memories/<handle>/MEDIUM.md` — a `prov=` attribute on the entry's `<!-- mm … -->`
//     annotation (parseSegment ignores attributes it does not know, so an old file still parses,
//     and a row written before this feature defaults from its `source` — see provFromSource).
//   • `user_profiles.facts_json` — an IN-BAND prefix on the fact text (`stated: likes golf`).
//     There is nowhere else to put it: the column is a JSON array of strings. So the read boundary
//     always strips the prefix (parseProvenance / normalizeFact) and dedupe compares BODIES, which
//     is what lets a stated write promote an inferred row in place instead of stacking a twin.
//     The price of an in-band grammar is that a fact whose own first word is one of the three
//     followed by a colon loses that word on render. Accepted deliberately: no DDL.
//
// THE FLAG. `MEMORY_PROVENANCE_ENABLED`, default **OFF** (the one default-off flag on this branch).
// Off, nothing is stamped and nothing is grouped: every byte of every file and every rendered
// prompt is what it was before this module existed. The parse and the strip run either way, so an
// install that ran with the flag ON and then turned it off still reads its own rows correctly.
//
// This module is the pure grammar plus ONE receipt emitter (recordFactProvenance) — the two write
// paths are in different layers and a receipt shaped in two places is a receipt that drifts.

import { record } from '../diagnostics/trace.js';

export const PROVENANCES = ['stated', 'inferred', 'seeded'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** stated 3 > seeded 2 > inferred 1. Their own words outrank an import; an import outranks a guess
 *  (the engine at least talked to them). `promote` is the only consumer that matters. */
export const PROV_RANK: Record<Provenance, number> = { stated: 3, seeded: 2, inferred: 1 };

/** The in-band prefix grammar, built FROM `PROVENANCES` so the two can never disagree about what
 *  `stated:` means — the `THREAD_NOTE_PREFIX_RE` pattern (`persona/threads.ts`). Case- and
 *  space-tolerant because a human hand-editing a memory file will not match our spacing, and the
 *  body is `[\s\S]+` so a groomed multi-line note keeps its shape. */
export const PROV_PREFIX_RE = new RegExp(`^(${PROVENANCES.join('|')})\\s*:\\s*([\\s\\S]+)$`, 'i');

/** The `source` the engine seed stamps on everything it writes. Lives here rather than in
 *  seedFromEngine.ts (which re-exports it under its historical name) so the db layer and the
 *  renderers can read it without closing an import cycle — the same move stripScopeSections made
 *  into userContext.ts. */
export const SEED_SOURCE = 'engine_seed';

/** The note that keeps a seeded picture honest, and the sentence the "imported" render group is
 *  wrapped in. Byte-pinned by seedFromEngine.test.ts: this is what stops her citing a seeded
 *  detail as something they said to her. */
export const SEED_NOTE = 'your first picture of them came from the engine you front, at install — hold it lightly, verify it naturally in conversation, and never cite it as something they told you';

/** What an unprefixed `user_profiles.facts_json` row means. That column only ever held facts
 *  written by `remember_user` off something the user said, so reading the whole legacy backlog as
 *  testimony is the truthful default — and the only one that cannot silently downgrade a fact
 *  they really did state. */
export const LEGACY_FACT_PROV: Provenance = 'stated';

/** Is this one of the three? The guard for a stored attribute or a hand edit — an unknown value is
 *  dropped rather than trusted, and never fatal to the row carrying it. */
export function isProvenance(v: unknown): v is Provenance {
  return typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v);
}

/** Text → its claimed provenance and its body. `prov: null` means the text claims nothing (an
 *  unprefixed row); the body is then the text itself, untouched. */
export function parseProvenance(text: string): { prov: Provenance | null; body: string } {
  const raw = typeof text === 'string' ? text : '';
  const m = PROV_PREFIX_RE.exec(raw);
  if (!m) return { prov: null, body: raw };
  return { prov: m[1].toLowerCase() as Provenance, body: m[2] };
}

/** The compare form for dedupe: the body with any prefix stripped, wording and casing intact (the
 *  caller that folds case does it itself — profiles.ts). Two rows differing only in who says so
 *  are the same fact, which is what makes promotion-in-place possible. */
export function normalizeFact(text: string): string {
  return parseProvenance(text).body;
}

/** Body → stamped text. Idempotent: a row that already carries a prefix is re-stamped, never
 *  double-stamped, so a promotion writes `stated: x` and not `stated: inferred: x`. */
export function stampFact(prov: Provenance, text: string): string {
  return `${prov}: ${normalizeFact(text)}`;
}

/** Max by rank — the one rule this module exists for. Never demotes. */
export function promote(a: Provenance, b: Provenance): Provenance {
  return PROV_RANK[b] > PROV_RANK[a] ? b : a;
}

/** A model's `basis` tool arg → a provenance. ONLY the literal word "stated" is taken as a claim
 *  of testimony; missing, garbled, wrong-typed, and `seeded` (which no live turn can honestly
 *  claim — only the installer seeds) all land on `inferred`. Conservative on purpose: a wrong
 *  "stated" becomes a fact she will defend as something they said. */
export function coerceBasis(raw: unknown): Provenance {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'stated' ? 'stated' : 'inferred';
}

/** The legacy default for a MEDIUM.md row written before `prov=` existed: the engine seed's own
 *  source means imported, anything else (a live turn, the groomer) means testimony. */
export function provFromSource(source: string | undefined): Provenance {
  return source === SEED_SOURCE ? 'seeded' : LEGACY_FACT_PROV;
}

/** The feature gate (env `MEMORY_PROVENANCE_ENABLED`). Default **OFF**, read at CALL time so a
 *  flip needs no restart, parsed like `threadingEnabled()` (`db/repositories/threadInventory.ts`)
 *  — the accepted words are identical; only the empty default is inverted, because this feature
 *  changes what a durable file contains and earns its way on rather than being assumed. */
export function provenanceEnabled(): boolean {
  const v = (process.env.MEMORY_PROVENANCE_ENABLED || '').trim().toLowerCase();
  if (v === '') return false;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Which store a fact write landed in. Disjoint buckets so a receipt reader can count per store
 *  (the `threads:select` model: every write reports, and every report says which bucket). */
export const FACT_PROV_STORES = ['medium_fact', 'medium_note', 'medium_directive', 'profile_fact'] as const;
export type FactProvStore = (typeof FACT_PROV_STORES)[number];

/** What the write actually did. `unchanged` IS the no-op dedupe path — the one a receipt usually
 *  loses, and the one that answers "why is her memory not growing". */
export const FACT_PROV_OUTCOMES = ['written', 'promoted', 'unchanged'] as const;
export type FactProvOutcome = (typeof FACT_PROV_OUTCOMES)[number];

/**
 * The `memory:fact_provenance` receipt — fired on EVERY durable write of a fact-shaped row,
 * including the no-op dedupe. Shaped in one place because the two write paths live in two layers
 * (memoryMedium.ts and profiles.ts) and a receipt built twice is a receipt that drifts.
 *
 * Carries names, keys and provenance only — never a fact BODY. The ring persists for 30 days and a
 * stored fact is the user's own life; the key plus the outcome is enough to attribute a write.
 *
 * `enabled` says whether provenance was actually stamped, so a reader can tell "she filed this as
 * a guess" from "the feature is off and nothing was filed at all".
 */
export function recordFactProvenance(r: {
  handle: string;
  store: FactProvStore;
  outcome: FactProvOutcome;
  prov: Provenance;
  /** What the row said before this write, when there was a row. */
  prior?: Provenance | null;
  /** The fact slot, for the keyed stores. Absent for a note/directive/profile fact. */
  key?: string;
}): void {
  record({
    type: 'event',
    label: 'memory:fact_provenance',
    handle: r.handle,
    detail: {
      store: r.store,
      outcome: r.outcome,
      prov: r.prov,
      ...(r.prior !== undefined ? { prior: r.prior } : {}),
      ...(r.key ? { key: r.key } : {}),
      enabled: provenanceEnabled(),
    },
  });
}
