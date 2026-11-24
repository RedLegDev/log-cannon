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

// Scope hierarchy (inherited from the retired v1 dashboard's api-auth.ts).
const SCOPE_HIERARCHY: Record<Scope, Scope[]> = {
  admin: ["admin", "write", "read", "ingest"],
  write: ["write", "read", "ingest"],
  read: ["read", "ingest"],
  ingest: ["ingest"],
};

// Two cache tiers sit in front of D1.
//
// L1 is in-isolate, scoped to the Worker isolate. Cloudflare reuses isolates
// across many requests, so a Map populated by one request serves hits for all
// subsequent requests in the same isolate at zero D1 cost.
//
// L2 is the colo's Cache API (`caches.default`), shared by every isolate in
// the data center, so a cold isolate usually resolves a key without D1 (refs
// #151). Entries are keyed on a SHA-256 of the API key, never the key itself,
// and carry the absolute expiry set when the record was read from D1. An L1
// entry filled from L2 expires at that same instant, so a record is never
// served more than KEY_CACHE_TTL_MS after it was read from D1, whichever tier
// serves it. Only found records (enabled or disabled) are cached; an unknown
// key always goes to D1. A failing or stalled L2 never fails auth: the lookup
// falls through to D1.
//
// Trade-off (unchanged from the previous KV implementation): when a key is
// disabled or deleted, warm isolates and other colos serve the stale entry for
// up to KEY_CACHE_TTL_MS. Acceptable for an ingest endpoint where compromise
// response is "rotate + redeploy", not "instant revoke".
interface CachedKey {
  record: APIKeyRecord;
  expiresAt: number;
}
const KEY_CACHE = new Map<string, CachedKey>();
export const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Longest a cold lookup (L2, then D1) may take before auth gives up with
 * `KeyLookupTimeoutError`, which callers answer with a 503 and `Retry-After`.
 * Senders time out at about 5 s (#112), and a slow D1 has held auth for 5 to
 * 30 s, so without a bound the sender aborts and retries a batch the Worker
 * may never have seen (refs #151).
 */
export const KEY_LOOKUP_TIMEOUT_MS = 4_000;

/** Longest the L2 read may take before the lookup skips it and asks D1. */
export const KEY_L2_TIMEOUT_MS = 500;

/** Seconds a 503 from a timed-out lookup tells the sender to wait. */
export const KEY_LOOKUP_RETRY_AFTER_S = 3;

/** The lookup's time limits and its L2 cache. Mutable so tests can shorten
 * the limits or swap the cache; nothing else should touch it. */
export const keyLookup = {
  timeoutMs: KEY_LOOKUP_TIMEOUT_MS,
  l2TimeoutMs: KEY_L2_TIMEOUT_MS,
  l2: (): Cache => caches.default,
};

/** A cold key lookup ran past `keyLookup.timeoutMs`. Not the client's fault:
 * callers map it to 503 with `Retry-After`, never to 401/403. */
export class KeyLookupTimeoutError extends Error {
  constructor(ms: number) {
    super(`API key lookup timed out after ${ms} ms`);
    this.name = "KeyLookupTimeoutError";
  }
}

// Part of every L2 URL. Always "" in production, so every isolate shares one
// namespace; `__resetKeyCache` moves tests to a fresh one, because the Cache
// API has no "clear everything" and outlives a test's L1.
let l2Namespace = "";

/** Test-only. Clears the module-level cache between cases, and points L2 at a
 * namespace no earlier case wrote to. `keepL2` clears L1 only, which is what a
 * fresh isolate in the same colo sees. */
export function __resetKeyCache(opts: { keepL2?: boolean } = {}): void {
  KEY_CACHE.clear();
  if (!opts.keepL2) l2Namespace = `${crypto.randomUUID()}/`;
}

/**
 * Whether this isolate can resolve `apiKey` without any I/O (an L1 hit). A
 * peek only — it never populates or expires an entry. An L2 hit still costs a
 * cache read, so it doesn't count; `resolveKey` reports it as `"l2"`.
 */
export function isKeyCached(apiKey: string, now: number = Date.now()): boolean {
  return cachedRecord(apiKey, now) !== undefined;
}

/** The single definition of "this isolate still holds a usable entry". */
function cachedRecord(
  apiKey: string,
  now: number,
): APIKeyRecord | undefined {
  const cached = KEY_CACHE.get(apiKey);
  return cached && cached.expiresAt > now ? cached.record : undefined;
}

async function l2Url(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `https://key-cache.log-cannon.internal/v1/${l2Namespace}${hex}`;
}

/** Rejects with `onTimeout()` if `work` hasn't settled in `ms`. The race keeps
 * a handler on the abandoned work, so its late rejection isn't unhandled. */
async function race<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(onTimeout()), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (id !== undefined) clearTimeout(id);
  }
}

/** The L2 entry for `apiKey` if it is still live at `now`. Never throws. */
async function readL2(apiKey: string, now: number): Promise<CachedKey | undefined> {
  try {
    const read = (async () => {
      const res = await keyLookup.l2().match(await l2Url(apiKey));
      if (!res) return undefined;
      const entry = (await res.json()) as CachedKey;
      return entry?.record && typeof entry.expiresAt === "number" ? entry : undefined;
    })();
    const entry = await race(read, keyLookup.l2TimeoutMs, () => new Error("L2 read timed out"));
    return entry && entry.expiresAt > now ? entry : undefined;
  } catch (e) {
    console.warn(JSON.stringify({ event: "key-cache-l2-read-failed", error: e instanceof Error ? e.message : String(e) }));
    return undefined;
  }
}

/** Store `entry` in L2 until its own expiry. Never rejects. */
async function writeL2(apiKey: string, entry: CachedKey, now: number): Promise<void> {
  try {
    const ttlS = Math.ceil((entry.expiresAt - now) / 1000);
    if (ttlS <= 0) return;
    await keyLookup.l2().put(
      await l2Url(apiKey),
      new Response(JSON.stringify(entry), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ttlS}`,
        },
      }),
    );
  } catch (e) {
    console.warn(JSON.stringify({ event: "key-cache-l2-write-failed", error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Drop `apiKey`'s L2 entry after a mutation. The Cache API's delete is
 * colo-local: it clears this data center's copy, and other colos keep theirs
 * until it expires, so a revocation can still take up to KEY_CACHE_TTL_MS to
 * reach everywhere (the same bound as before L2). Never rejects.
 */
async function deleteL2(apiKey: string): Promise<void> {
  try {
    await keyLookup.l2().delete(await l2Url(apiKey));
  } catch (e) {
    console.warn(JSON.stringify({ event: "key-cache-l2-delete-failed", error: e instanceof Error ? e.message : String(e) }));
  }
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

/** Where a key's record came from: this isolate, the colo cache, or D1. */
export type KeySource = "l1" | "l2" | "d1";

export interface ResolveOptions {
  /** Keeps the L2 write (and a timed-out D1 read's cache fill) alive after
   * the response. Without it they run unawaited, which a short-lived
   * invocation may cut off; that only costs a later cache miss. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * Resolves an API key to its record and the tier that answered. Throws on
 * unknown or disabled keys, and `KeyLookupTimeoutError` when the cold lookup
 * ran past `keyLookup.timeoutMs`. `now` is injectable so cache-expiry
 * behaviour is testable without fake timers.
 */
export async function resolveKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
  opts: ResolveOptions = {},
): Promise<{ record: APIKeyRecord; source: KeySource }> {
  const cached = cachedRecord(apiKey, now);
  if (cached) return { record: enabledOrThrow(cached), source: "l1" };

  // Date.now() rather than `now`: the deadline is real elapsed I/O time, and
  // `now` may be a test's fixed clock.
  const started = Date.now();
  const background = (p: Promise<unknown>) => {
    if (opts.waitUntil) opts.waitUntil(p);
  };

  const fromL2 = await readL2(apiKey, now);
  if (fromL2) {
    KEY_CACHE.set(apiKey, fromL2);
    return { record: enabledOrThrow(fromL2.record), source: "l2" };
  }

  // A budget the L2 read already spent (only possible with a limit shorter
  // than its own) doesn't start a D1 read nobody will wait for.
  if (keyLookup.timeoutMs - (Date.now() - started) <= 0) {
    throw new KeyLookupTimeoutError(keyLookup.timeoutMs);
  }

  // The D1 read fills both tiers when it lands, even after the lookup timed
  // out, so the sender's retry finds the key cached.
  const read = db
    .prepare(
      `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
       FROM api_keys WHERE api_key = ?`,
    )
    .bind(apiKey)
    .first<Row>()
    .then((row) => {
      if (!row) return undefined;
      // Timed from the lookup's start, not the row's arrival: the row is no
      // older than that, so a late read can't stretch the staleness bound.
      const entry: CachedKey = {
        record: toRecord(row),
        expiresAt: now + KEY_CACHE_TTL_MS,
      };
      KEY_CACHE.set(apiKey, entry);
      background(writeL2(apiKey, entry, now + (Date.now() - started)));
      return entry.record;
    });

  const left = keyLookup.timeoutMs - (Date.now() - started);
  let record: APIKeyRecord | undefined;
  try {
    record = await race(read, left, () => new KeyLookupTimeoutError(keyLookup.timeoutMs));
  } catch (e) {
    if (e instanceof KeyLookupTimeoutError) {
      // Keep the invocation alive for the late fill; a late failure is
      // already handled by the race and is nothing to report twice.
      background(read.catch(() => undefined));
    }
    throw e;
  }

  if (!record) throw new Error("Invalid API key");
  return { record: enabledOrThrow(record), source: "d1" };
}

function enabledOrThrow(record: APIKeyRecord): APIKeyRecord {
  if (!record.enabled) throw new Error("API key is disabled");
  return record;
}

/** `resolveKey`, for callers that only need the record. */
export async function validateKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
  opts: ResolveOptions = {},
): Promise<APIKeyRecord> {
  return (await resolveKey(apiKey, db, now, opts)).record;
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
  // `sets` holds only the fixed "<column> = ?" literals above; every value is bound.
  // nosemgrep: js-sql-built-from-strings
  const { results } = await db
    .prepare(
      `UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ? RETURNING api_key`,
    )
    .bind(...binds)
    .all<{ api_key: string }>();

  await forgetKeys(results);
  return results.length > 0;
}

/**
 * Drop mutated keys from both cache tiers. L1 is cleared whole rather than
 * tracking key_id → api_key; other isolates still honour the TTL. L2 loses
 * each mutated key's entry in this colo only (see `deleteL2`).
 */
async function forgetKeys(rows: { api_key: string }[]): Promise<void> {
  KEY_CACHE.clear();
  await Promise.all(rows.map((r) => deleteL2(r.api_key)));
}

export async function deleteKey(
  db: D1Database,
  keyId: string,
): Promise<boolean> {
  const { results } = await db
    .prepare("DELETE FROM api_keys WHERE key_id = ? RETURNING api_key")
    .bind(keyId)
    .all<{ api_key: string }>();
  await forgetKeys(results);
  return results.length > 0;
}
