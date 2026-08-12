// Medium-term tier renderers — how memory_medium rows become prompt sections. The blocks
// are ported from the legacy prefs-based renderers (userContext.ts structured prefs +
// important notes, preferences.ts directive block) so wording doesn't drift; only the
// data source changed (first-class rows instead of JSONB arrays).

import { listMediumActive, type MediumEntry } from '../db/repositories/memoryMedium.js';
import type { Directive } from '../db/repositories/memory.js';

// The directive block renderer stays in preferences.ts beside its sanitizer and framing
// (the safety layers); re-exported here so tier consumers import one module.
export { renderDirectiveBlock } from './preferences.js';

/** The structured fact slots (conversationally-learned, user-describing — never operational flags
 *  like chat_id/gmail_*). The canonical list: set_preference routes these to the medium tier, and
 *  renderFactsBlock renders them. Reflexion may also mint descriptive new slots beyond these. */
export const FACT_KEYS: ReadonlySet<string> = new Set([
  'comms_style', 'address_as',
]);

/** The three medium-kind partitions, adapted to the shapes the legacy renderers expect. */
export interface MediumBundle {
  directives: Directive[];
  notes: string[];
  facts: Record<string, string>;
}

/** One listMediumActive call, partitioned by kind. Reads degrade to an empty bundle. */
export async function loadMediumBundle(handle: string): Promise<MediumBundle> {
  const rows = await listMediumActive(handle);
  const bundle: MediumBundle = { directives: [], notes: [], facts: {} };
  for (const row of rows) {
    if (row.kind === 'directive') bundle.directives.push({ id: row.id, text: row.body, createdAt: row.createdAt });
    else if (row.kind === 'important_note') bundle.notes.push(row.body);
    else if (row.kind === 'fact' && row.key) bundle.facts[row.key] = row.body;
  }
  return bundle;
}

/** Rows-in variant for callers that already listed the tier (avoids a second read). */
export function partitionMediumRows(rows: MediumEntry[]): MediumBundle {
  const bundle: MediumBundle = { directives: [], notes: [], facts: {} };
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (row.kind === 'directive') bundle.directives.push({ id: row.id, text: row.body, createdAt: row.createdAt });
    else if (row.kind === 'important_note') bundle.notes.push(row.body);
    else if (row.kind === 'fact' && row.key) bundle.facts[row.key] = row.body;
  }
  return bundle;
}

/** Facts the user explicitly asked Irises to remember — verbatim, never summarized away. */
export function renderNotesBlock(notes: string[]): string {
  const clean = notes.filter(n => typeof n === 'string' && n.trim());
  if (!clean.length) return '';
  return `## Things they told you to remember (keep these top of mind, they asked explicitly)\n${clean.map(n => `- ${n}`).join('\n')}`;
}

/** Structured facts the user told us about themselves (not operational flags). The canonical
 *  slots render first, in a fixed order; any other durable fact Reflexion minted renders after. */
export function renderFactsBlock(facts: Record<string, string>): string {
  const lines: string[] = [];
  if (facts.comms_style) lines.push(`comms style: ${facts.comms_style}`);
  // Descriptive slots beyond the canonical ones (e.g. minted by Reflexion) — render them too so a
  // durable fact never goes unseen. address_as is rendered by the addressing header, not here.
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'comms_style' || key === 'address_as' || !value) continue;
    lines.push(`${key.replace(/_/g, ' ')}: ${value}`);
  }
  return lines.join('\n');
}
