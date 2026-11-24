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
// #151). Entries are keyed on a SHA-256 of the API key under a deployment
// namespace, and their body never holds the key: `apiKey` is stripped before
// the write and restored from the presented key on read. Each carries the
// absolute expiry set when the record was read from D1. An L1 entry filled
// from L2 expires at that same instant, so a record is never served more than
// KEY_CACHE_TTL_MS after its D1 read began, whichever tier serves it. An entry
// that claims a later expiry or doesn't look like a record is a miss. Only
// found records (enabled or disabled) are cached; an unknown key always goes
// to D1. A failing or stalled L2 never fails auth: the lookup falls through.
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

/** What a cold lookup found, and where. `undefined`: no such key. */
type ColdResult = { entry: CachedKey; source: "l2" | "d1" } | undefined;

// Cold lookups in flight in this isolate, by API key. A request that misses
// L1 while one is running joins it rather than starting its own, so a stalled
// D1 holds one query per key, not one per sender retry.
const IN_FLIGHT = new Map<string, Promise<ColdResult>>();

// Bumped whenever this isolate mutates a key (and by `__resetKeyCache`). A
// cold lookup that began under an older generation may have read the row
// before the change, so its result isn't cached in either tier: without this,
// a D1 read that timed out, then landed after an admin disabled the key, would
// re-cache it as enabled for another TTL. Per isolate only: another isolate's
// in-flight read can still land stale, bounded as ever by KEY_CACHE_TTL_MS.
let generation = 0;

/**
 * Longest a cold lookup (L2, then D1) may take before auth gives up with
 * `KeyLookupTimeoutError`, which callers answer with a 503 and `Retry-After`.
 * Senders time out at about 5 s (#112), and a slow D1 has held auth for 5 to
 * 30 s, so without a bound the sender aborts and retries a batch the Worker
 * may never have seen (refs #151). Each caller's bound runs from its own
 * start, including one that joined a lookup already in flight.
 */
export const KEY_LOOKUP_TIMEOUT_MS = 4_000;

/** Longest an L2 read or delete may take before it is abandoned. */
export const KEY_L2_TIMEOUT_MS = 500;

/** Seconds a 503 from a timed-out lookup tells the sender to wait. */
export const KEY_LOOKUP_RETRY_AFTER_S = 3;

/** Part of every L2 URL; bump it when the stored entry's shape changes. */
const L2_VERSION = "v2";

/** L2 namespace when `KEY_CACHE_NAMESPACE` is unset. */
export const DEFAULT_KEY_CACHE_NAMESPACE = "default";

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

/** An unknown or disabled key. `source` is the tier that said so, so a
 * rejected request still reports where its answer came from. */
export class KeyRejectedError extends Error {
  constructor(
    message: "Invalid API key" | "API key is disabled",
    public readonly source: KeySource,
  ) {
    super(message);
    this.name = "KeyRejectedError";
  }
}

// Test-only addition to every L2 URL: `__resetKeyCache` moves tests to a
// fresh one, because the Cache API has no "clear everything" and outlives a
// test's L1. Always "" in production.
let testNamespace = "";

/** Test-only. Clears the module-level cache between cases, and points L2 at a
 * namespace no earlier case wrote to. `keepL2` clears L1 only, which is what a
 * fresh isolate in the same colo sees. Either way a lookup still in flight
 * from an earlier case can't fill the cache. */
export function __resetKeyCache(opts: { keepL2?: boolean } = {}): void {
  KEY_CACHE.clear();
  IN_FLIGHT.clear();
  generation++;
  if (!opts.keepL2) testNamespace = `${crypto.randomUUID()}/`;
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

async function l2Url(apiKey: string, namespace: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `https://key-cache.log-cannon.internal/${L2_VERSION}/${encodeURIComponent(namespace)}/${testNamespace}${hex}`;
}

/** Rejects with `onTimeout()` if `work` hasn't settled in `ms`. The race keeps
 * a handler on the abandoned work, so its late rejection isn't unhandled. A
 * budget already spent loses at once, not a timer tick later. */
async function race<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    ms <= 0
      ? Promise.reject(onTimeout())
      : new Promise<never>((_, reject) => {
          id = setTimeout(() => reject(onTimeout()), ms);
        });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (id !== undefined) clearTimeout(id);
  }
}

/** The stored L2 body: a record without its API key. */
type StoredKey = { record: Omit<APIKeyRecord, "apiKey">; expiresAt: number };

/** Whether `v` is an entry this code wrote and still trusts at `now`. */
function isLiveEntry(v: unknown, now: number): v is StoredKey {
  if (!v || typeof v !== "object") return false;
  const { record: r, expiresAt } = v as Record<string, unknown>;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  // Never trust an entry for longer than one TTL from now.
  if (expiresAt <= now || expiresAt > now + KEY_CACHE_TTL_MS) return false;
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return (
    typeof rec.keyId === "string" &&
    typeof rec.name === "string" &&
    typeof rec.enabled === "boolean" &&
    typeof rec.retentionDays === "number" &&
    typeof rec.createdAt === "string" &&
    Array.isArray(rec.scopes) &&
    rec.scopes.every((sc) => VALID_SCOPES.includes(sc as Scope)) &&
    !("apiKey" in rec)
  );
}

/** The L2 entry for `apiKey` if it is live and well-formed. Never throws. */
async function readL2(apiKey: string, now: number, namespace: string): Promise<CachedKey | undefined> {
  try {
    const read = (async () => {
      const res = await keyLookup.l2().match(await l2Url(apiKey, namespace));
      return res ? ((await res.json()) as unknown) : undefined;
    })();
    const body = await race(read, keyLookup.l2TimeoutMs, () => new Error("L2 read timed out"));
    if (body === undefined || !isLiveEntry(body, now)) return undefined;
    return { record: { ...body.record, apiKey }, expiresAt: body.expiresAt };
  } catch (e) {
    console.warn(JSON.stringify({ event: "key-cache-l2-read-failed", error: e instanceof Error ? e.message : String(e) }));
    return undefined;
  }
}

/** Store `entry` in L2 until its own expiry, without the API key. Never rejects. */
async function writeL2(apiKey: string, entry: CachedKey, now: number, namespace: string): Promise<void> {
  try {
    const ttlS = Math.ceil((entry.expiresAt - now) / 1000);
    if (ttlS <= 0) return;
    const { apiKey: _omit, ...record } = entry.record;
    const stored: StoredKey = { record, expiresAt: entry.expiresAt };
    await keyLookup.l2().put(
      await l2Url(apiKey, namespace),
      new Response(JSON.stringify(stored), {
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
 * Drop `apiKey`'s L2 entry after a mutation, within `keyLookup.l2TimeoutMs`.
 * The Cache API's delete is colo-local: it clears this data center's copy,
 * and other colos keep theirs until it expires, so a revocation can still take
 * up to KEY_CACHE_TTL_MS to reach everywhere (the same bound as before L2).
 * Never rejects.
 */
async function deleteL2(apiKey: string, namespace: string): Promise<void> {
  try {
    // `return await`, not `return`: a delete that rejects at once would
    // otherwise sit unhandled for a microtask, which workerd reports.
    const del = (async () => {
      const url = await l2Url(apiKey, namespace);
      return await keyLookup.l2().delete(url);
    })();
    await race(del, keyLookup.l2TimeoutMs, () => new Error("L2 delete timed out"));
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

export interface KeyCacheOptions {
  /** L2 namespace for this deployment (`KEY_CACHE_NAMESPACE`), so two
   * deployments in one zone never share entries. Defaults to
   * DEFAULT_KEY_CACHE_NAMESPACE. */
  namespace?: string;
  /** Keeps L2 writes and deletes (and a timed-out D1 read's cache fill)
   * alive after the response. Without it a write or a lookup's fill runs
   * unawaited, which a short-lived invocation may cut off; that only costs a
   * later cache miss. A mutation without it awaits its bounded L2 delete. */
  waitUntil?: (p: Promise<unknown>) => void;
}

function namespaceOf(opts: KeyCacheOptions): string {
  return opts.namespace?.trim() || DEFAULT_KEY_CACHE_NAMESPACE;
}

/**
 * The shared part of a cold lookup: L2, then D1, then fill both tiers, unless
 * a key changed in this isolate while it ran.
 */
function coldLookup(
  apiKey: string,
  db: D1Database,
  now: number,
  opts: KeyCacheOptions,
): Promise<ColdResult> {
  const namespace = namespaceOf(opts);
  const startedGeneration = generation;
  const started = Date.now();
  const stillCurrent = () => generation === startedGeneration;

  const lookup = (async (): Promise<ColdResult> => {
    const fromL2 = await readL2(apiKey, now, namespace);
    if (fromL2) {
      if (stillCurrent()) KEY_CACHE.set(apiKey, fromL2);
      return { entry: fromL2, source: "l2" };
    }
    const row = await db
      .prepare(
        `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
         FROM api_keys WHERE api_key = ?`,
      )
      .bind(apiKey)
      .first<Row>();
    if (!row) return undefined;
    // Timed from the lookup's start, not the row's arrival: the row is no
    // older than that, so a late read can't stretch the staleness bound.
    const entry: CachedKey = {
      record: toRecord(row),
      expiresAt: now + KEY_CACHE_TTL_MS,
    };
    if (stillCurrent()) {
      KEY_CACHE.set(apiKey, entry);
      const write = writeL2(apiKey, entry, now + (Date.now() - started), namespace);
      if (opts.waitUntil) opts.waitUntil(write);
    }
    return { entry, source: "d1" };
  })();

  const shared = lookup.finally(() => {
    if (IN_FLIGHT.get(apiKey) === shared) IN_FLIGHT.delete(apiKey);
  });
  IN_FLIGHT.set(apiKey, shared);
  return shared;
}

/**
 * Resolves an API key to its record and the tier that answered. Throws
 * `KeyRejectedError` on unknown or disabled keys, and `KeyLookupTimeoutError`
 * when this caller's cold lookup ran past `keyLookup.timeoutMs`. `now` is
 * injectable so cache-expiry behaviour is testable without fake timers.
 */
export async function resolveKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
  opts: KeyCacheOptions = {},
): Promise<{ record: APIKeyRecord; source: KeySource }> {
  const cached = cachedRecord(apiKey, now);
  if (cached) return { record: enabledOrThrow(cached, "l1"), source: "l1" };

  // Date.now() rather than `now`: the deadline is real elapsed I/O time, and
  // `now` may be a test's fixed clock.
  const started = Date.now();
  const lookup = IN_FLIGHT.get(apiKey) ?? coldLookup(apiKey, db, now, opts);

  let result: ColdResult;
  try {
    result = await race(lookup, keyLookup.timeoutMs - (Date.now() - started), () => new KeyLookupTimeoutError(keyLookup.timeoutMs));
  } catch (e) {
    if (e instanceof KeyLookupTimeoutError && opts.waitUntil) {
      // Keep the invocation alive for the late fill; a late failure is
      // already handled by the race and is nothing to report twice.
      opts.waitUntil(lookup.catch(() => undefined));
    }
    throw e;
  }

  if (!result) throw new KeyRejectedError("Invalid API key", "d1");
  return { record: enabledOrThrow(result.entry.record, result.source), source: result.source };
}

function enabledOrThrow(record: APIKeyRecord, source: KeySource): APIKeyRecord {
  if (!record.enabled) throw new KeyRejectedError("API key is disabled", source);
  return record;
}

/** `resolveKey`, for callers that only need the record. */
export async function validateKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
  opts: KeyCacheOptions = {},
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
  opts: KeyCacheOptions = {},
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

  await forgetKeys(results, opts);
  return results.length > 0;
}

/**
 * Drop mutated keys from both cache tiers. L1 is cleared whole rather than
 * tracking key_id → api_key; other isolates still honour the TTL. The
 * generation bump stops a cold lookup already running in this isolate from
 * re-caching what it read before the change, and the next request starts a
 * fresh one. L2 loses each mutated key's entry in this colo only (see
 * `deleteL2`): in `waitUntil` when there is one, else awaited, bounded, and
 * never failing, since D1 has already committed.
 */
async function forgetKeys(rows: { api_key: string }[], opts: KeyCacheOptions): Promise<void> {
  generation++;
  KEY_CACHE.clear();
  IN_FLIGHT.clear();
  const namespace = namespaceOf(opts);
  const deletes = Promise.all(rows.map((r) => deleteL2(r.api_key, namespace)));
  if (opts.waitUntil) opts.waitUntil(deletes);
  else await deletes;
}

export async function deleteKey(
  db: D1Database,
  keyId: string,
  opts: KeyCacheOptions = {},
): Promise<boolean> {
  const { results } = await db
    .prepare("DELETE FROM api_keys WHERE key_id = ? RETURNING api_key")
    .bind(keyId)
    .all<{ api_key: string }>();
  await forgetKeys(results, opts);
  return results.length > 0;
}
