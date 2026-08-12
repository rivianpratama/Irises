import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import type { UserProfile } from '../types.js';

export type { UserProfile } from '../types.js';

const toEpoch = (ts: string | null | undefined): number =>
  ts ? Math.floor(Date.parse(ts) / 1000) : Math.floor(Date.now() / 1000);

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('handle, name, facts, first_seen, last_seen')
        .eq('handle', handle)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        handle: data.handle,
        name: data.name ?? null,
        facts: data.facts ?? [],
        firstSeen: toEpoch(data.first_seen),
        lastSeen: toEpoch(data.last_seen),
      };
    } catch (error) {
      logDbError('getUserProfile', error);
    }
  }
  return mem.profiles.get(handle) ?? null;
}

/** Every known user profile, most recently seen first (dashboard roster). */
export async function listUserProfiles(limit = 500): Promise<UserProfile[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('handle, name, facts, first_seen, last_seen')
        .order('last_seen', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(d => ({
        handle: d.handle as string,
        name: (d.name as string | null) ?? null,
        facts: (d.facts as string[]) ?? [],
        firstSeen: toEpoch(d.first_seen as string | null),
        lastSeen: toEpoch(d.last_seen as string | null),
      }));
    } catch (error) {
      logDbError('listUserProfiles', error);
    }
  }
  return [...mem.profiles.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
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

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('user_profiles').upsert({
        handle: profile.handle,
        name: profile.name,
        facts: profile.facts,
        first_seen: new Date(profile.firstSeen * 1000).toISOString(),
        last_seen: new Date(profile.lastSeen * 1000).toISOString(),
      }, { onConflict: 'handle' });
      if (error) throw error;
      console.log(`[conversation] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
      return;
    } catch (error) {
      logDbError('updateUserProfile', error);
    }
  }
  mem.profiles.set(handle, profile);
  console.log(`[conversation] (Fallback) Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
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
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('user_profiles').delete().eq('handle', handle);
      if (error) throw error;
      console.log(`[conversation] Cleared profile for ${handle}`);
      return true;
    } catch (error) {
      logDbError('clearUserProfile', error);
    }
  }
  const deleted = mem.profiles.delete(handle);
  if (deleted) console.log(`[conversation] (Fallback) Cleared profile for ${handle}`);
  return deleted;
}
