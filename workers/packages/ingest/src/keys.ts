// API key registry backed by D1. This is the sole source of truth for ingest
// authentication — see docs/superpowers/specs/2026-08-06-api-key-registry-d1-design.md.

export type Scope = "ingest" | "read" | "write" | "admin";

export interface APIKeyRecord {
  apiKey: string;
  keyId: string;
  name: string;
  enabled: boolean;
  scopes: Scope[];
  retentionDays: number;
  createdAt: string;
}

interface Row {
  api_key: string;
  key_id: string;
  name: string;
  enabled: number;
  scopes: string;
  retention_days: number;
  created_at: string;
}

// Scope hierarchy mirrors dashboard/src/lib/api-auth.ts so the two agree.
const SCOPE_HIERARCHY: Record<Scope, Scope[]> = {
  admin: ["admin", "write", "read", "ingest"],
  write: ["write", "read", "ingest"],
  read: ["read", "ingest"],
  ingest: ["ingest"],
};

// In-isolate cache, scoped to the Worker isolate. Cloudflare reuses isolates
// across many requests, so a Map populated by one request serves hits for all
// subsequent requests in the same isolate at zero D1 cost.
//
// Trade-off (unchanged from the previous KV implementation): when a key is
// disabled or deleted, warm isolates serve the stale entry for up to
// KEY_CACHE_TTL_MS. Acceptable for an ingest endpoint where compromise
// response is "rotate + redeploy", not "instant revoke".
interface CachedKey {
  record: APIKeyRecord;
  expiresAt: number;
}
const KEY_CACHE = new Map<string, CachedKey>();
export const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Test-only. Clears the module-level cache between cases. */
export function __resetKeyCache(): void {
  KEY_CACHE.clear();
}

function toRecord(row: Row): APIKeyRecord {
  return {
    apiKey: row.api_key,
    keyId: row.key_id,
    name: row.name,
    enabled: row.enabled === 1,
    scopes: parseScopes(row.scopes),
    retentionDays: row.retention_days,
    createdAt: row.created_at,
  };
}

export function parseScopes(scopes: string): Scope[] {
  if (!scopes) return ["ingest"];
  return scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Scope[];
}

export function hasScope(record: APIKeyRecord, required: Scope): boolean {
  return record.scopes.some((held) =>
    SCOPE_HIERARCHY[held]?.includes(required),
  );
}

/**
 * Resolves an API key to its record. Throws on unknown or disabled keys.
 * `now` is injectable so cache-expiry behaviour is testable without fake timers.
 */
export async function validateKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
): Promise<APIKeyRecord> {
  const cached = KEY_CACHE.get(apiKey);
  if (cached && cached.expiresAt > now) {
    if (!cached.record.enabled) throw new Error("API key is disabled");
    return cached.record;
  }

  const row = await db
    .prepare(
      `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
       FROM api_keys WHERE api_key = ?`,
    )
    .bind(apiKey)
    .first<Row>();

  if (!row) throw new Error("Invalid API key");

  const record = toRecord(row);
  KEY_CACHE.set(apiKey, { record, expiresAt: now + KEY_CACHE_TTL_MS });

  if (!record.enabled) throw new Error("API key is disabled");
  return record;
}
