interface CacheEntry {
  data: unknown;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export function get(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

export function set(key: string, data: unknown, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;

  cache.set(key, {
    data,
    expires: Date.now() + ttlSeconds * 1000
  });
}

export function invalidate(key: string): void {
  cache.delete(key);
}

export function clear(): void {
  cache.clear();
}
