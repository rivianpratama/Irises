// Medium-term tier renderers — how memory_medium rows become prompt sections. The blocks
// are ported from the legacy prefs-based renderers (userContext.ts structured prefs +
// important notes, preferences.ts directive block) so wording doesn't drift; only the
// data source changed (first-class rows instead of JSONB arrays).

import { entryProvenance, listMediumActive, type MediumEntry } from '../db/repositories/memoryMedium.js';
import type { Directive } from '../db/repositories/memory.js';
import {
  LEGACY_FACT_PROV, PROVENANCES, SEED_FACT_KEY, SEED_NOTE, isProvenance, normalizeFact,
  parseProvenance, provenanceEnabled, type Provenance,
} from './provenance.js';
import { REPLY_LANGUAGE_KEY, parseLanguageDirective } from './standingSettings.js';
import { foldLanguageDirectives } from './replyLanguage.js';

// The directive block renderer stays in preferences.ts beside its sanitizer and framing
// (the safety layers); re-exported here so tier consumers import one module.
export { renderDirectiveBlock } from './preferences.js';

/** The structured fact slots (conversationally-learned, user-describing — never operational flags
 *  like chat_id). The canonical list: set_preference routes these to the medium tier, and
 *  renderFactsBlock renders them. Curation may also mint descriptive new slots beyond these. */
export const FACT_KEYS: ReadonlySet<string> = new Set([
  'comms_style', 'address_as', REPLY_LANGUAGE_KEY,
]);

/** The three medium-kind partitions, adapted to the shapes the legacy renderers expect. */
export interface MediumBundle {
  directives: Directive[];
  notes: string[];
  facts: Record<string, string>;
  /** Who says so, per fact key (memory/provenance.ts). Filled by both loaders below off each row,
   *  whether or not `MEMORY_PROVENANCE_ENABLED` is on — a row written before the flag existed still
   *  answers, off its `source`. OPTIONAL because plenty of callers hand-build a bundle from facts
   *  alone; a key with no answer falls back to `factLineProv`'s default. */
  factProv?: Record<string, Provenance>;
  /** WHEN each fact was written (the row's `createdAt`), per key. A standing setting renders with
   *  its date — a lane that knows the language was asked for yesterday can weigh it against what
   *  it sees in the visible thread, which an undated rule made impossible. OPTIONAL for the same
   *  reason `factProv` is: plenty of callers hand-build a bundle from a facts map alone, and a key
   *  with no answer simply renders without a date. */
  factAt?: Record<string, number>;
}

/**
 * One listMediumActive call, partitioned by kind. Reads degrade to an empty bundle.
 *
 * The fold hook: a language rule from the era when a language WAS a directive gets carried into
 * the `reply_language` slot the first time this handle is read (memory/replyLanguage.ts), and the
 * tier is re-listed so the caller never renders both. Task A4 stops new language directives being
 * created, so only legacy rows ever qualify and this write-on-read fires at most once per handle —
 * which is also the migration, since VPS memory files are never hand-edited.
 */
export async function loadMediumBundle(handle: string): Promise<MediumBundle> {
  let rows = await listMediumActive(handle);
  if (rows.some(r => r.status === 'active' && r.kind === 'directive' && parseLanguageDirective(r.body) !== null)) {
    await foldLanguageDirectives(handle);
    rows = await listMediumActive(handle);
  }
  return partitionMediumRows(rows);
}

/** Rows-in variant for callers that already listed the tier (avoids a second read). */
export function partitionMediumRows(rows: MediumEntry[]): MediumBundle {
  const factProv: Record<string, Provenance> = {};
  const factAt: Record<string, number> = {};
  const bundle: MediumBundle = { directives: [], notes: [], facts: {}, factProv, factAt };
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (row.kind === 'directive') bundle.directives.push({ id: row.id, text: row.body, createdAt: row.createdAt });
    else if (row.kind === 'important_note') bundle.notes.push(row.body);
    else if (row.kind === 'fact' && row.key) {
      bundle.facts[row.key] = row.body;
      factProv[row.key] = entryProvenance(row);
      factAt[row.key] = row.createdAt;
    }
  }
  return bundle;
}

/** Facts the user explicitly asked Irises to remember — verbatim, never summarized away. */
export function renderNotesBlock(notes: string[]): string {
  const clean = notes.filter(n => typeof n === 'string' && n.trim());
  if (!clean.length) return '';
  return `## Things they told you to remember (keep these top of mind, they asked explicitly)\n${clean.map(n => `- ${n}`).join('\n')}`;
}

/** The keys the identity card renders itself (memory/wrappers.ts renderIdentityCard): what to call
 *  them, how they text, where they are. `address_as` was always the addressing header's; the other
 *  two join it once the card is in the stack, so no identity value reaches the model twice. */
export const CARD_FACT_KEYS: ReadonlySet<string> = new Set([
  'address_as', 'comms_style', 'agent_tz', REPLY_LANGUAGE_KEY,
]);

/**
 * How each of the three claims is announced. A `Record<Provenance, …>`, so the vocabulary and the
 * headings cannot disagree: a fourth provenance would not compile until it had a heading, and a
 * render can never silently drop a whole class of fact.
 *
 * The heading does the qualifying once for every fact under it, which is what keeps this affordable
 * in prompt budget. "hold lightly" is the whole instruction for a guess; the imported group carries
 * `SEED_NOTE` verbatim, because a seeded fact needs the longer sentence (second-hand about a person
 * she has never spoken to) and that sentence is already byte-pinned by seedFromEngine.test.ts.
 */
const PROV_HEADINGS: Record<Provenance, string> = {
  stated: 'facts they told you:',
  inferred: 'facts you gathered (hold lightly):',
  seeded: `facts imported (verify naturally): ${SEED_NOTE}`,
};

/** The render groups, in the order both fact renderers emit them — which is `PROVENANCES`' own
 *  declared order, i.e. descending rank: the strongest claim reads first and the two she must hold
 *  loosely arrive already qualified. Reordering `PROVENANCES` reorders these deliberately. */
export const PROV_GROUPS: ReadonlyArray<{ prov: Provenance; heading: string }> =
  PROVENANCES.map(prov => ({ prov, heading: PROV_HEADINGS[prov] }));

/**
 * Who says so about ONE fact key, for the renderers. An answer the loader recorded wins. With no
 * answer: `SEED_FACT_KEY` reads as `seeded` and everything else as the legacy default (`stated`).
 *
 * That seed special case is the point, not a shortcut — plenty of callers build a bundle from a
 * facts map alone, and the brief's rule is absolute: the engine's second-hand details may never
 * render under "facts they told you". The key is enough to know, because the seed writes exactly
 * one row and it writes it under that key.
 */
function factLineProv(key: string, prov: Record<string, Provenance> | undefined): Provenance {
  const claimed = prov?.[key];
  if (isProvenance(claimed)) return claimed;
  return key === SEED_FACT_KEY ? 'seeded' : LEGACY_FACT_PROV;
}

/** Structured facts the user told us about themselves (not operational flags). The canonical
 *  slots render first, in a fixed order; any other minted durable fact renders after.
 *
 *  `omitCardKeys` drops the identity keys the card above this block already states. Off by
 *  default, so the pre-card path renders exactly the bytes it always did.
 *
 *  `prov` is who says so, per key (`MediumBundle.factProv`). While `MEMORY_PROVENANCE_ENABLED` is
 *  on the lines are grouped under `PROV_GROUPS`' headings; off, it is ignored entirely and the
 *  block is the flat list it always was, byte for byte, on both the routed and the unrouted path. */
export function renderFactsBlock(
  facts: Record<string, string>,
  opts: { omitCardKeys?: boolean; prov?: Record<string, Provenance> } = {},
): string {
  const lines: Array<{ prov: Provenance; text: string }> = [];
  const push = (key: string, text: string) => lines.push({ prov: factLineProv(key, opts.prov), text });
  if (facts.comms_style && !opts.omitCardKeys) push('comms_style', `comms style: ${facts.comms_style}`);
  // Descriptive slots beyond the canonical ones — render them too so a
  // durable fact never goes unseen. address_as is rendered by the addressing header, not here.
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'comms_style' || key === 'address_as' || !value) continue;
    // The standing setting is rendered ONCE, dated, by the addressing header — the only memory the
    // prompt laws name as its authority (memory/wrappers.ts law (b)). Unconditional, unlike the
    // card keys below: `omitCardKeys` is off on the pre-card path, so a gated skip would print an
    // undated second copy exactly where nothing is allowed to set the language.
    if (key === REPLY_LANGUAGE_KEY) continue;
    if (opts.omitCardKeys && CARD_FACT_KEYS.has(key)) continue;
    push(key, `${key.replace(/_/g, ' ')}: ${value}`);
  }
  if (!provenanceEnabled()) return lines.map(l => l.text).join('\n');
  // A group with nothing in it renders NO heading — an empty "facts you gathered" is a claim about
  // her own guessing, and a stack of empty headings is prompt budget spent on nothing.
  return PROV_GROUPS
    .flatMap(g => {
      const own = lines.filter(l => l.prov === g.prov);
      return own.length ? [g.heading, ...own.map(l => l.text)] : [];
    })
    .join('\n');
}

/**
 * The profile's `Known facts` list (`user_profiles.facts_json`) — the OTHER fact store, and the one
 * that carries its provenance in-band, as a prefix on the fact text (memory/provenance.ts explains
 * why: that column is a JSON array of strings and there is nowhere else to put it).
 *
 * So the prefix is stripped here on BOTH paths — it is a storage detail and the model must never
 * read `stated: likes golf` as the fact — and grouped under the same three headings as the block
 * above while the flag is on. Flag off: `Known facts:` and the bullets, exactly today's bytes.
 *
 * Shared by the live addressing header (memory/wrappers.ts) and the transition shim
 * (memory/userContext.ts) so the two renderings of one list cannot drift.
 */
export function renderKnownFacts(facts: readonly string[]): string {
  if (!facts.length) return '';
  const rows = facts.map(f => ({ prov: parseFactProv(f), text: normalizeFact(f) }));
  if (!provenanceEnabled()) return `Known facts:\n- ${rows.map(r => r.text).join('\n- ')}`;
  return ['Known facts:', ...PROV_GROUPS.flatMap(g => {
    const own = rows.filter(r => r.prov === g.prov);
    return own.length ? [g.heading, ...own.map(r => `- ${r.text}`)] : [];
  })].join('\n');
}

/** An in-band profile fact's own claim, or the legacy default for an unprefixed row (that column
 *  only ever held facts `remember_user` wrote off something the user said). */
function parseFactProv(fact: string): Provenance {
  const { prov } = parseProvenance(fact);
  return prov ?? LEGACY_FACT_PROV;
}
