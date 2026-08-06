// Client for the ingest Worker's key registry admin API. The dashboard does
// not own a key store — D1 behind the Worker is the sole source of truth.

const INGEST_URL = process.env.LOG_CANNON_INGEST_URL ?? 'https://logs.redleg.dev';
const ADMIN_KEY = process.env.LOG_CANNON_ADMIN_KEY ?? '';

export interface KeyRecord {
  apiKey: string;
  keyId: string;
  name: string;
  enabled: boolean;
  scopes: string[];
  retentionDays: number;
  createdAt: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!ADMIN_KEY) {
    throw new Error('LOG_CANNON_ADMIN_KEY is not configured');
  }

  const res = await fetch(`${INGEST_URL}${path}`, {
    ...init,
    headers: {
      'X-Api-Key': ADMIN_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Key registry returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listKeys(): Promise<KeyRecord[]> {
  const { keys } = await call<{ keys: KeyRecord[] }>('/v1/keys');
  return keys;
}

export async function createKey(name: string, scopes: string): Promise<KeyRecord> {
  return call<KeyRecord>('/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name, scopes }),
  });
}

export async function updateKey(
  keyId: string,
  patch: { name?: string; enabled?: boolean; scopes?: string; retentionDays?: number }
): Promise<void> {
  await call(`/v1/keys/${encodeURIComponent(keyId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteKey(keyId: string): Promise<void> {
  await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
}

// Short-lived cache so per-request dashboard API auth does not make an edge
// round-trip on every call. Deliberately shorter than the Worker's 5-minute
// isolate cache — dashboard auth guards read/write/admin, not ingest.
const AUTH_CACHE_TTL_MS = 30_000;
let authCache: { keys: KeyRecord[]; expiresAt: number } | null = null;

export async function lookupKey(apiKey: string): Promise<KeyRecord | null> {
  const now = Date.now();
  if (!authCache || authCache.expiresAt <= now) {
    authCache = { keys: await listKeys(), expiresAt: now + AUTH_CACHE_TTL_MS };
  }
  return authCache.keys.find(k => k.apiKey === apiKey) ?? null;
}

export function __resetAuthCache(): void {
  authCache = null;
}
