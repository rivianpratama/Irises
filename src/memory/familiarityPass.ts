// The familiarity pass: after a reply, count the turn, read what she holds about them, and move the
// stored level toward what that adds up to (persona/familiarity.ts owns the arithmetic). No model
// call, and the turn never waits on it: agents/convo/shared.ts fires it beside the climate eval,
// under the same group skip, and a failure costs this one tick and nothing else.
//
// The turn reads only the stored row, so the mask runs one turn behind the harvests. A two-point
// slew makes that lag invisible.
//
// SERIALIZED PER HANDLE, in this module: a fast follow-up can start its pass before the last one has
// saved, and two passes that both read the same row would lose a tick. The chain is local on purpose
// (the shared per-handle lock in db/repositories/memory.ts is taken by some of the reads below, and a
// pass holding it would deadlock on its own read).

import { getFamiliarity, saveFamiliarity } from '../db/repositories/familiarity.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { listMediumActive } from '../db/repositories/memoryMedium.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { readMoments } from '../db/repositories/moments.js';
import { readSelf, type SelfKind } from '../db/repositories/self.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { familiarityEnabled, momentsEnabled, selfEnabled } from '../persona/featureFlags.js';
import {
  FAMILIARITY_START, bandOf, slewLevel, targetLevel, tickCounters, type FamiliarityEvidence,
} from '../persona/familiarity.js';
import { partitionMediumRows } from './mediumTerm.js';
import { LEGACY_FACT_PROV, parseProvenance, type Provenance } from './provenance.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';

/** Filed whenever the stored band changes, with the old band, the new one and the level. */
export const FAMILIARITY_BAND_LABEL = 'familiarity:band';

/** The SELF.md kinds that are about HER. A learned entry is about them, and is not counted. */
const HER_OWN: ReadonlySet<SelfKind> = new Set<SelfKind>(['stance', 'taste', 'changed']);

/**
 * What she holds about this person, as counts, plus the two lived-exchange counters handed in. Every
 * read here degrades to empty on its own, so this never throws. A store behind a switch that is off
 * contributes nothing: she genuinely holds less. Medium facts are listed rather than loaded through
 * `loadMediumBundle`, so this is a pure read (the dashboard calls it too) and never folds a legacy
 * language directive on the way past.
 */
export async function gatherFamiliarityEvidence(
  handle: string,
  counters: { turns: number; activeDays: number },
): Promise<FamiliarityEvidence> {
  const [facts, profile, moments, inventory, self] = await Promise.all([
    listMediumActive(handle, ['fact']),
    getUserProfile(handle),
    momentsEnabled() ? readMoments(handle) : Promise.resolve(null),
    threadingEnabled() ? getThreadInventory(handle) : Promise.resolve(null),
    selfEnabled() ? readSelf(handle) : Promise.resolve(null),
  ]);
  const byProv: Record<Provenance, number> = { stated: 0, inferred: 0, seeded: 0 };
  const medium = partitionMediumRows(facts);
  for (const key of Object.keys(medium.facts)) byProv[medium.factProv?.[key] ?? LEGACY_FACT_PROV]++;
  // An unprefixed profile fact is a legacy row, which reads as stated (provenance.ts LEGACY_FACT_PROV).
  for (const fact of profile?.facts ?? []) byProv[parseProvenance(fact).prov ?? LEGACY_FACT_PROV]++;
  return {
    turns: counters.turns,
    activeDays: counters.activeDays,
    statedFacts: byProv.stated,
    inferredFacts: byProv.inferred,
    seededFacts: byProv.seeded,
    name: profile?.name ? 1 : 0,
    moments: moments?.entries.length ?? 0,
    themesTaken: inventory?.themes.filter(t => t.uptakes >= 1).length ?? 0,
    loops: inventory?.loops.length ?? 0,
    selfEntries: self?.entries.filter(e => HER_OWN.has(e.kind)).length ?? 0,
  };
}

/** One pass: tick, read, slew, save, and receipt a band change. */
async function familiarityPass(handle: string, opts: { chatId?: string; now?: number }): Promise<void> {
  const now = opts.now ?? Date.now();
  // Read BEFORE the stores and handed to the save: a /forget landing mid-pass must not have its wipe
  // undone by a level computed from what it wiped.
  const epoch = getForgetEpoch(handle);
  const prior = await getFamiliarity(handle);
  const counters = tickCounters(prior, now);
  const evidence = await gatherFamiliarityEvidence(handle, counters);
  const level = slewLevel(prior?.level ?? null, targetLevel(evidence));
  const saved = await saveFamiliarity(handle, { level, ...counters }, { ifForgetEpoch: epoch });
  if (!saved) return;
  const from = bandOf(prior?.level ?? FAMILIARITY_START);
  const to = bandOf(level);
  if (from !== to) {
    record({ type: 'event', label: FAMILIARITY_BAND_LABEL, chatId: opts.chatId, handle, detail: { from, to, level } });
  }
}

const chains = new Map<string, Promise<void>>();

/**
 * Count this replied turn for `handle` and move its level. Fire-and-forget at the call site; the
 * returned promise never rejects (a failure is logged and the level stays where it was), and it
 * resolves once THIS handle's queued passes up to and including this one have run. A no-op with the
 * switch off, with no handle, and for a room, which is front stage and never gets a level.
 */
export function updateFamiliarity(handle: string, opts: { chatId?: string; now?: number } = {}): Promise<void> {
  if (!familiarityEnabled() || !handle || isGroupHandle(handle)) return Promise.resolve();
  const next = (chains.get(handle) ?? Promise.resolve())
    .then(() => familiarityPass(handle, opts))
    .catch(err => { console.warn('[familiarity] pass failed, the level is unchanged', err); });
  chains.set(handle, next);
  void next.then(() => { if (chains.get(handle) === next) chains.delete(handle); });
  return next;
}
