import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { withHandleLock } from './memory.js';
import { archiveEntries } from './memoryArchive.js';
import {
  LEGACY_FACT_PROV, normalizeFact as factBody, parseProvenance, promote, provenanceEnabled,
  recordFactProvenance, stampFact, type Provenance,
} from '../../memory/provenance.js';
import type { UserProfile } from '../types.js';

export type { UserProfile } from '../types.js';

// user_profiles speaks epoch SECONDS at the API boundary (types.ts back-compat quirk);
// the columns store the same unit so nothing converts.
//
// Concurrency: every MUTATOR here is a read→merge→upsert, so each one runs its WHOLE
// sequence inside ONE withHandleLock (the same per-handle queue the memory tiers use).
// Two concurrent addUserFact calls used to each read the same facts array and one write
// silently clobbered the other's fact. The lock is NOT re-entrant, so the mutators call
// the private sync readRow/writeRow helpers below — never the exported getters.

type ProfileRow = { handle: string; name: string | null; facts_json: string; first_seen: number; last_seen: number };

/** Cap on stored facts. Overflow evicts the OLDEST into the archive (never a silent drop,
 *  and never a refusal of the new fact — the newest thing they said always lands). */
export const PROFILE_FACTS_CAP = 30;

function rowToProfile(r: ProfileRow): UserProfile {
  let facts: string[] = [];
  try { facts = JSON.parse(r.facts_json) as string[]; } catch { /* unparseable → no facts */ }
  return { handle: r.handle, name: r.name ?? null, facts, firstSeen: r.first_seen, lastSeen: r.last_seen };
}

/** The profile row, or null when absent. Sync + throwing: the locked mutators need a read
 *  failure to abort the merge rather than rebuild the profile from an assumed-empty base. */
function readRow(handle: string): UserProfile | null {
  const r = stmt(
    'SELECT handle, name, facts_json, first_seen, last_seen FROM user_profiles WHERE handle = ?'
  ).get(handle) as ProfileRow | undefined;
  return r ? rowToProfile(r) : null;
}

/** Upsert a merged profile. Sync + throwing (the callers log). */
function writeRow(p: UserProfile): void {
  stmt(
    `INSERT INTO user_profiles (handle, name, facts_json, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       name = excluded.name, facts_json = excluded.facts_json, last_seen = excluded.last_seen`
  ).run(p.handle, p.name, JSON.stringify(p.facts), p.firstSeen, p.lastSeen);
}

/** Merge `updates` onto the row read in the same locked section, and write it. Throws on a read
 *  or write failure — the exported mutators own the logging. */
function mergeAndWrite(handle: string, updates: { name?: string; facts?: string[] }): UserProfile {
  const existing = readRow(handle);
  const now = Math.floor(Date.now() / 1000);
  const profile: UserProfile = {
    handle,
    name: updates.name ?? existing?.name ?? null,
    facts: updates.facts ?? existing?.facts ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  writeRow(profile);
  return profile;
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  try {
    return readRow(handle);
  } catch (error) {
    logDbError('getUserProfile', error);
    return null;
  }
}

/** Every known user profile, most recently seen first (dashboard roster). */
export async function listUserProfiles(limit = 500): Promise<UserProfile[]> {
  try {
    const rows = stmt(
      'SELECT handle, name, facts_json, first_seen, last_seen FROM user_profiles ORDER BY last_seen DESC LIMIT ?'
    ).all(limit) as unknown as ProfileRow[];
    return rows.map(rowToProfile);
  } catch (error) {
    logDbError('listUserProfiles', error);
    return [];
  }
}

export async function updateUserProfile(
  handle: string,
  updates: { name?: string; facts?: string[] },
): Promise<void> {
  await withHandleLock(handle, async () => {
    try {
      const profile = mergeAndWrite(handle, updates);
      console.log(`[conversation] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
    } catch (error) {
      logDbError('updateUserProfile', error);
    }
  });
}

/** Compare form for fact dedupe: casing and stray whitespace must not create a second copy
 *  of the same fact ("Likes  Golf " vs "likes golf"), and neither must the provenance prefix
 *  (memory/provenance.ts) — two rows differing only in WHO SAYS SO are the same fact, which is
 *  what lets a stated write promote an inferred row in place. The strip runs whether the feature
 *  is on or off, so an install that tried it and turned it off cannot stack a duplicate. */
function normalizeFact(fact: string): string {
  return factBody(fact).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Append a fact, deduped by body. `basis` is who says so; it is stored as an in-band prefix while
 * `MEMORY_PROVENANCE_ENABLED` is on and ignored entirely while it is off (the column then holds the
 * exact bytes it always did).
 *
 * Returns whether a NEW fact landed. A promotion returns **false**: the fact was already known, so
 * the turn's confirmation beat must stay what it was for something she already had — the write is
 * on the `memory:fact_provenance` receipt instead.
 */
export async function addUserFact(handle: string, fact: string, basis: Provenance = LEGACY_FACT_PROV): Promise<boolean> {
  return withHandleLock(handle, async () => {
    let evicted: string[] = [];
    let added = false;
    try {
      const existing = readRow(handle);
      const facts = [...(existing?.facts ?? [])];
      const target = normalizeFact(fact);
      const at = facts.findIndex(f => normalizeFact(f) === target);
      if (at >= 0) {
        // The dedupe path — and the one write it can still make. Their own words about a fact she
        // had guessed raise it IN PLACE: same slot in the array, the row's ORIGINAL wording kept
        // (that is what a re-statement confirms), only the prefix changes. A basis that would not
        // rise writes nothing at all, so the no-op stays a no-op.
        const prior = parseProvenance(facts[at]).prov ?? LEGACY_FACT_PROV;
        const merged = provenanceEnabled() ? promote(prior, basis) : prior;
        if (merged !== prior) {
          facts[at] = stampFact(merged, facts[at]);
          mergeAndWrite(handle, { facts });
          console.log(`[conversation] Promoted fact for ${handle} to ${merged}: "${fact}"`);
        } else {
          console.log(`[conversation] Fact for ${handle} already exists, skipping: "${fact}"`);
        }
        recordFactProvenance({
          handle, store: 'profile_fact', prov: merged, prior,
          outcome: merged !== prior ? 'promoted' : 'unchanged',
        });
        return false;
      }
      // What the stored row will READ as — with the feature off nothing is stamped, so it reads as
      // the legacy default, and the receipt says that rather than a basis nobody recorded.
      const filed = provenanceEnabled() ? basis : LEGACY_FACT_PROV;
      facts.push(provenanceEnabled() ? stampFact(basis, fact) : fact);
      if (facts.length > PROFILE_FACTS_CAP) evicted = facts.splice(0, facts.length - PROFILE_FACTS_CAP);
      mergeAndWrite(handle, { facts });
      added = true;
      console.log(`[conversation] Added fact for ${handle}: "${fact}"`);
      recordFactProvenance({ handle, store: 'profile_fact', prov: filed, prior: null, outcome: 'written' });
    } catch (error) {
      logDbError('addUserFact', error);
      return false;
    }
    // Lineage for the evicted facts, outside the try so a write success is never reported as a
    // failure by an archive hiccup (archiveEntries never throws anyway).
    if (evicted.length) {
      const now = Date.now();
      await archiveEntries(evicted.map(f => ({
        source: 'profile_fact_evicted' as const,
        agentHandle: handle,
        content: f,
        createdAt: now,
      })));
    }
    return added;
  });
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  return withHandleLock(handle, async () => {
    try {
      const existing = readRow(handle);
      if (existing?.name === name) {
        console.log(`[conversation] Name for ${handle} already "${name}", skipping`);
        return false;
      }
      mergeAndWrite(handle, { name });
      console.log(`[conversation] Set name for ${handle}: "${name}"`);
      return true;
    } catch (error) {
      logDbError('setUserName', error);
      return false;
    }
  });
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  try {
    const deleted = Number(stmt('DELETE FROM user_profiles WHERE handle = ?').run(handle).changes) > 0;
    if (deleted) console.log(`[conversation] Cleared profile for ${handle}`);
    return deleted;
  } catch (error) {
    logDbError('clearUserProfile', error);
    return false;
  }
}
