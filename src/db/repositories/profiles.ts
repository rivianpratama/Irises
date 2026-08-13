import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import type { UserProfile } from '../types.js';

export type { UserProfile } from '../types.js';

// user_profiles speaks epoch SECONDS at the API boundary (types.ts back-compat quirk);
// the columns store the same unit so nothing converts.

type ProfileRow = { handle: string; name: string | null; facts_json: string; first_seen: number; last_seen: number };

function rowToProfile(r: ProfileRow): UserProfile {
  let facts: string[] = [];
  try { facts = JSON.parse(r.facts_json) as string[]; } catch { /* unparseable → no facts */ }
  return { handle: r.handle, name: r.name ?? null, facts, firstSeen: r.first_seen, lastSeen: r.last_seen };
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  try {
    const r = stmt(
      'SELECT handle, name, facts_json, first_seen, last_seen FROM user_profiles WHERE handle = ?'
    ).get(handle) as ProfileRow | undefined;
    return r ? rowToProfile(r) : null;
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
  const existing = await getUserProfile(handle);
  const now = Math.floor(Date.now() / 1000);
  const profile: UserProfile = {
    handle,
    name: updates.name ?? existing?.name ?? null,
    facts: updates.facts ?? existing?.facts ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  try {
    stmt(
      `INSERT INTO user_profiles (handle, name, facts_json, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         name = excluded.name, facts_json = excluded.facts_json, last_seen = excluded.last_seen`
    ).run(profile.handle, profile.name, JSON.stringify(profile.facts), profile.firstSeen, profile.lastSeen);
    console.log(`[conversation] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
  } catch (error) {
    logDbError('updateUserProfile', error);
  }
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  const existing = await getUserProfile(handle);
  const facts = existing?.facts ?? [];
  if (facts.includes(fact)) {
    console.log(`[conversation] Fact for ${handle} already exists, skipping: "${fact}"`);
    return false;
  }
  facts.push(fact);
  await updateUserProfile(handle, { facts });
  console.log(`[conversation] Added fact for ${handle}: "${fact}"`);
  return true;
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  const existing = await getUserProfile(handle);
  if (existing?.name === name) {
    console.log(`[conversation] Name for ${handle} already "${name}", skipping`);
    return false;
  }
  await updateUserProfile(handle, { name });
  console.log(`[conversation] Set name for ${handle}: "${name}"`);
  return true;
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
