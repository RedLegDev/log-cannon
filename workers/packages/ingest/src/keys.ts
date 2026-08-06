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

export const VALID_SCOPES: Scope[] = ["ingest", "read", "write", "admin"];

export function invalidScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !VALID_SCOPES.includes(s as Scope));
}

/** 32 chars of base62, matching the dashboard's historical key format. */
export function generateAPIKey(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function listKeys(db: D1Database): Promise<APIKeyRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
       FROM api_keys ORDER BY created_at DESC`,
    )
    .all<Row>();
  return results.map(toRecord);
}

export async function createKey(
  db: D1Database,
  name: string,
  scopes: string,
  now: string = new Date().toISOString(),
): Promise<APIKeyRecord> {
  const apiKey = generateAPIKey();
  const keyId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
       VALUES (?, ?, ?, 1, ?, 0, ?)`,
    )
    .bind(apiKey, keyId, name, scopes, now)
    .run();

  return {
    apiKey,
    keyId,
    name,
    enabled: true,
    scopes: parseScopes(scopes),
    retentionDays: 0,
    createdAt: now,
  };
}

export interface KeyPatch {
  name?: string;
  enabled?: boolean;
  scopes?: string;
  retentionDays?: number;
}

export async function updateKey(
  db: D1Database,
  keyId: string,
  patch: KeyPatch,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(patch.enabled ? 1 : 0);
  }
  if (patch.scopes !== undefined) {
    sets.push("scopes = ?");
    binds.push(patch.scopes);
  }
  if (patch.retentionDays !== undefined) {
    sets.push("retention_days = ?");
    binds.push(patch.retentionDays);
  }
  if (sets.length === 0) return false;

  binds.push(keyId);
  const result = await db
    .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ?`)
    .bind(...binds)
    .run();

  // A mutated key may be cached in this isolate; drop the whole cache rather
  // than track key_id → api_key. Other isolates still honour the TTL.
  KEY_CACHE.clear();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteKey(
  db: D1Database,
  keyId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM api_keys WHERE key_id = ?")
    .bind(keyId)
    .run();
  KEY_CACHE.clear();
  return (result.meta.changes ?? 0) > 0;
}
