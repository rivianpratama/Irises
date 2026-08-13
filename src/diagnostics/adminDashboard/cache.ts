// Tiny TTL memo for dashboard API reads, so the client poll loops never hammer
// the data layer (generalizes the 10s persisted-rows cache the old dashboard had).
// Concurrent callers of a cold key share one in-flight promise.

interface Entry {
  at: number;
  value: unknown;
}

const store = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const inflight = pending.get(key);
  if (inflight) return inflight as Promise<T>;
  const p = fn().then(value => {
    store.set(key, { at: Date.now(), value });
    pending.delete(key);
    return value;
  }, err => {
    pending.delete(key);
    throw err;
  });
  pending.set(key, p);
  return p;
}

/** Test hook. */
export function clearCache(): void {
  store.clear();
  pending.clear();
}
