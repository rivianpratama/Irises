// The familiarity pass: after a reply, count the turn, read what she holds about them, and move the
// stored level toward what that adds up to (persona/familiarity.ts owns the arithmetic). No model
// call, and the turn never waits on it: agents/convo/shared.ts fires it beside the climate eval,
// under the same group skip, and a failure costs this one tick and nothing else.
//
// A FIRST ROW is seeded from tenure (the profile's first-seen days and the harvested turns, read in
// the same store reads as the evidence) and lands straight on its target, so someone she has known
// for months is not walked up from the bottom two points a turn. Every later pass slews.
//
// The turn reads only the stored row, so the mask runs one turn behind the harvests. A two-point
// slew makes that lag invisible.
//
// SERIALIZED PER HANDLE, in this module: a fast follow-up can start its pass before the last one has
// saved, and two passes that both read the same row would lose a tick. The chain QUEUES, where its
// siblings skip: climate and the harvests drop a call that lands while one is in flight, which for a
// counter would be a turn never counted. And it is local rather than the shared per-handle lock in
// db/repositories/memory.ts, because nothing here writes what that lock guards, so there is no
// reason to wait behind the harvests' writes.

import { getFamiliarity, saveFamiliarity } from '../db/repositories/familiarity.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { listMediumActive } from '../db/repositories/memoryMedium.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { readMoments } from '../db/repositories/moments.js';
import { readSelf, type SelfKind } from '../db/repositories/self.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { familiarityEnabled, momentsEnabled, selfEnabled } from '../persona/featureFlags.js';
import {
  FAMILIARITY_START, bandOf, seedCounters, slewLevel, targetLevel, tickCounters, type FamiliarityEvidence,
} from '../persona/familiarity.js';
import { partitionMediumRows } from './mediumTerm.js';
import { LEGACY_FACT_PROV, parseProvenance, type Provenance } from './provenance.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';

/** Filed whenever the stored band changes, with the old band, the new one and the level. */
export const FAMILIARITY_BAND_LABEL = 'familiarity:band';

/** The SELF.md kinds that are about HER. A learned entry is about them, and is not counted. */
const HER_OWN: ReadonlySet<SelfKind> = new Set<SelfKind>(['stance', 'taste', 'changed']);

/** What she holds, without the two lived-exchange counters (those are the row's, not the stores'). */
type HeldCounts = Omit<FamiliarityEvidence, 'turns' | 'activeDays'>;

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
  return withCounters((await gatherHeld(handle)).held, counters);
}

/** The evidence: the held counts, and the lived-exchange counters beside them. */
function withCounters(held: HeldCounts, counters: { turns: number; activeDays: number }): FamiliarityEvidence {
  return { turns: counters.turns, activeDays: counters.activeDays, ...held };
}

/** One read of every store: the held counts; the two readings a first row is seeded from (the
 *  profile's first-seen instant in ms, the inventory's harvested turns); and whether a file-backed
 *  store came back `degraded`: unreadable, and so empty for a reason that says nothing about what
 *  she holds. */
async function gatherHeld(handle: string): Promise<{
  held: HeldCounts;
  seed: { firstSeenMs: number | null; harvestCount: number };
  degraded: boolean;
}> {
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
  const held: HeldCounts = {
    statedFacts: byProv.stated,
    inferredFacts: byProv.inferred,
    seededFacts: byProv.seeded,
    name: profile?.name ? 1 : 0,
    moments: moments?.entries.length ?? 0,
    themesTaken: inventory?.themes.filter(t => t.uptakes >= 1).length ?? 0,
    // Still open: a resolved or expired loop is kept a week before the prune (threads.ts), and it is
    // no longer something pending in their life. The live set is threads.ts's own reading of it.
    loops: inventory?.loops.filter(l => l.status === 'open' || l.status === 'asked').length ?? 0,
    selfEntries: self?.entries.filter(e => HER_OWN.has(e.kind)).length ?? 0,
  };
  // The profile speaks epoch SECONDS (db/types.ts); seedCounters reads a garbled one as no days.
  const seed = {
    firstSeenMs: typeof profile?.firstSeen === 'number' ? profile.firstSeen * 1000 : null,
    harvestCount: inventory?.harvestCount ?? 0,
  };
  return { held, seed, degraded: !!moments?.degraded || !!self?.degraded };
}

/** One pass: read, tick (a first row seeded from tenure), move, save, and receipt a band change. */
async function familiarityPass(handle: string, opts: { chatId?: string; now?: number }): Promise<void> {
  const now = opts.now ?? Date.now();
  // Read BEFORE the stores and handed to the save: a /forget landing mid-pass must not have its wipe
  // undone by a level computed from what it wiped.
  const epoch = getForgetEpoch(handle);
  const prior = await getFamiliarity(handle);
  const { held, seed, degraded } = await gatherHeld(handle);
  const counters = tickCounters(prior ?? seedCounters(seed, now), now);
  const target = targetLevel(withCounters(held, counters));
  // An unreadable store reads as empty, and empty would pull the level down. So a degraded read holds
  // the level where it was, and a first row at the start (one that could not read its evidence must
  // not jump); the turn and the day are still counted, because those are true.
  const level = degraded
    ? prior?.level ?? FAMILIARITY_START
    : prior ? slewLevel(prior.level, target) : target;
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
 * returned promise never rejects (a failure is reported and the level stays where it was), and it
 * resolves once THIS handle's queued passes up to and including this one have run. A no-op with the
 * switch off, with no handle, and for a room, which is front stage and never gets a level.
 */
export function updateFamiliarity(handle: string, opts: { chatId?: string; now?: number } = {}): Promise<void> {
  if (!familiarityEnabled() || !handle || isGroupHandle(handle)) return Promise.resolve();
  const next = (chains.get(handle) ?? Promise.resolve())
    .then(() => familiarityPass(handle, opts))
    .catch(err => {
      reportError({
        source: 'memory',
        category: 'other',
        severity: 'warn',
        message: 'familiarity pass failed, the level is unchanged',
        err,
        handle,
      });
    });
  chains.set(handle, next);
  void next.then(() => { if (chains.get(handle) === next) chains.delete(handle); });
  return next;
}
