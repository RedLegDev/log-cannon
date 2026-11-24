import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateKey,
  resolveKey,
  hasScope,
  updateKey,
  deleteKey,
  keyLookup,
  KeyLookupTimeoutError,
  KeyRejectedError,
  isKeyCached,
  KEY_CACHE_TTL_MS,
  KEY_LOOKUP_TIMEOUT_MS,
  KEY_L2_TIMEOUT_MS,
  __resetKeyCache,
} from "../src/keys";

async function insert(row: {
  apiKey: string;
  name: string;
  enabled?: number;
  scopes?: string;
}) {
  await env.KEYS_DB.prepare(
    `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
     VALUES (?, ?, ?, ?, ?, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(
      row.apiKey,
      `id-${row.apiKey}`,
      row.name,
      row.enabled ?? 1,
      row.scopes ?? "ingest",
    )
    .run();
}

describe("validateKey", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  });

  it("returns the record for a known enabled key", async () => {
    await insert({ apiKey: "k-good", name: "Readerful" });

    const record = await validateKey("k-good", env.KEYS_DB);

    expect(record.name).toBe("Readerful");
    expect(record.enabled).toBe(true);
    expect(record.scopes).toEqual(["ingest"]);
  });

  it("throws for an unknown key", async () => {
    await expect(validateKey("k-missing", env.KEYS_DB)).rejects.toThrow(
      "Invalid API key",
    );
  });

  it("throws for a disabled key", async () => {
    await insert({ apiKey: "k-off", name: "Old", enabled: 0 });

    await expect(validateKey("k-off", env.KEYS_DB)).rejects.toThrow(
      "API key is disabled",
    );
  });

  it("parses multi-scope keys", async () => {
    await insert({ apiKey: "k-admin", name: "Claude", scopes: "ingest,admin" });

    const record = await validateKey("k-admin", env.KEYS_DB);

    expect(record.scopes).toEqual(["ingest", "admin"]);
  });

  it("serves a second lookup from cache without re-reading D1", async () => {
    await insert({ apiKey: "k-cached", name: "First" });
    await validateKey("k-cached", env.KEYS_DB);

    await env.KEYS_DB.prepare(
      "UPDATE api_keys SET name = 'Second' WHERE api_key = 'k-cached'",
    ).run();
    const record = await validateKey("k-cached", env.KEYS_DB);

    expect(record.name).toBe("First");
  });

  it("re-reads D1 after the cache TTL expires", async () => {
    await insert({ apiKey: "k-ttl", name: "First" });
    const t0 = 1_000_000;
    await validateKey("k-ttl", env.KEYS_DB, t0);

    await env.KEYS_DB.prepare(
      "UPDATE api_keys SET name = 'Second' WHERE api_key = 'k-ttl'",
    ).run();
    const record = await validateKey("k-ttl", env.KEYS_DB, t0 + 5 * 60 * 1000 + 1);

    expect(record.name).toBe("Second");
  });
});

/** A D1 that fails the test if the lookup reaches it. */
const noD1 = {
  prepare() {
    throw new Error("D1 was queried");
  },
} as unknown as D1Database;

/** A D1 whose single-row read settles only when the test says so. */
function heldD1() {
  let settle!: { resolve: (row: unknown) => void; reject: (e: Error) => void };
  const first = new Promise((resolve, reject) => void (settle = { resolve, reject }));
  const calls = { prepare: 0 };
  const db = {
    prepare: () => {
      calls.prepare++;
      return { bind: () => ({ first: () => first }) };
    },
  } as unknown as D1Database;
  return { db, settle, calls };
}

/** An in-memory stand-in for `caches.default` that keeps the stored bodies. */
function memoryCache(seed: Record<string, string> = {}) {
  const bodies = new Map<string, string>(Object.entries(seed));
  const cache = {
    match: async (u: string) => (bodies.has(u) ? new Response(bodies.get(u)) : undefined),
    put: async (u: string, r: Response) => void bodies.set(u, await r.text()),
    delete: async (u: string) => bodies.delete(u),
  } as unknown as Cache;
  return { cache, bodies };
}

const ROW = {
  api_key: "k-held",
  key_id: "id-k-held",
  name: "Held",
  enabled: 1,
  scopes: "ingest",
  retention_days: 0,
  created_at: "2026-01-01T00:00:00Z",
};

/** Collects what the lookup hands `waitUntil`, so a test can wait for the L2
 * write before reading it back. */
function background() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    // Loops because a settling promise can register more (the late D1 fill
    // registers its L2 write).
    settled: async () => {
      let done = 0;
      while (done < pending.length) {
        const upTo = pending.length;
        await Promise.all(pending.slice(done, upTo));
        done = upTo;
      }
    },
  };
}

describe("two-tier key cache and bounded lookup (refs #151)", () => {
  const realL2 = keyLookup.l2;

  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  });

  afterEach(() => {
    keyLookup.timeoutMs = KEY_LOOKUP_TIMEOUT_MS;
    keyLookup.l2TimeoutMs = KEY_L2_TIMEOUT_MS;
    keyLookup.l2 = realL2;
  });

  it("serves a cold isolate from L2 without touching D1", async () => {
    await insert({ apiKey: "k-l2", name: "First" });
    const bg = background();
    expect((await resolveKey("k-l2", env.KEYS_DB, Date.now(), bg)).source).toBe("d1");
    await bg.settled();

    __resetKeyCache({ keepL2: true });
    const { record, source } = await resolveKey("k-l2", noD1);

    expect(source).toBe("l2");
    expect(record.name).toBe("First");
    // The stored entry has no key; the presented one is put back.
    expect(record.apiKey).toBe("k-l2");
    // And the L2 hit filled L1.
    expect((await resolveKey("k-l2", noD1)).source).toBe("l1");
  });

  it("keys L2 on a hash and never stores the raw API key", async () => {
    const { cache, bodies } = memoryCache();
    keyLookup.l2 = () => cache;
    await insert({ apiKey: "k-secret-value", name: "S" });
    const bg = background();
    await validateKey("k-secret-value", env.KEYS_DB, Date.now(), bg);
    await bg.settled();

    expect(bodies.size).toBe(1);
    const [[url, body]] = [...bodies];
    expect(url).not.toContain("k-secret-value");
    expect(url).toMatch(/[0-9a-f]{64}$/);
    // keyId is "id-k-secret-value" in these fixtures, so look for the key as a value.
    expect(body).not.toContain('"k-secret-value"');
    expect(JSON.parse(body).record).not.toHaveProperty("apiKey");
    expect(JSON.parse(body).record.name).toBe("S");
  });

  it("keeps deployments apart by namespace", async () => {
    const { cache } = memoryCache();
    keyLookup.l2 = () => cache;
    await insert({ apiKey: "k-ns", name: "NS" });
    const bg = background();
    await validateKey("k-ns", env.KEYS_DB, Date.now(), { ...bg, namespace: "production" });
    await bg.settled();

    __resetKeyCache({ keepL2: true });
    expect((await resolveKey("k-ns", noD1, Date.now(), { namespace: "production" })).source).toBe("l2");
    __resetKeyCache({ keepL2: true });
    expect((await resolveKey("k-ns", env.KEYS_DB, Date.now(), { namespace: "staging" })).source).toBe("d1");
  });

  it("treats an L2 entry it wouldn't have written as a miss", async () => {
    await insert({ apiKey: "k-forged", name: "Real", scopes: "ingest" });
    const now = Date.now();
    const good = { keyId: "id-k-forged", name: "Forged", enabled: true, scopes: ["admin"], retentionDays: 0, createdAt: "2026-01-01T00:00:00Z" };
    const forged = [
      { record: good, expiresAt: now + KEY_CACHE_TTL_MS * 100 },
      { record: { ...good, scopes: ["root"] }, expiresAt: now + 60_000 },
      { record: { ...good, scopes: "admin" }, expiresAt: now + 60_000 },
      { record: { ...good, enabled: "yes" }, expiresAt: now + 60_000 },
      { record: { ...good, apiKey: "k-forged" }, expiresAt: now + 60_000 },
      { record: good, expiresAt: "later" },
      { nope: true },
    ];

    // Learn the entry's URL from a real write, then overwrite its body.
    const { cache, bodies } = memoryCache();
    keyLookup.l2 = () => cache;
    const bg = background();
    await validateKey("k-forged", env.KEYS_DB, now, bg);
    await bg.settled();
    const [url] = [...bodies.keys()];
    // Sanity: the untouched entry is a hit.
    __resetKeyCache({ keepL2: true });
    expect((await resolveKey("k-forged", noD1, now)).source).toBe("l2");

    for (const entry of forged) {
      bodies.set(url, JSON.stringify(entry));
      __resetKeyCache({ keepL2: true });
      const { record, source } = await resolveKey("k-forged", env.KEYS_DB, now);
      expect(source).toBe("d1");
      expect(record.name).toBe("Real");
    }
  });

  it("reports the tier that rejected a key", async () => {
    await insert({ apiKey: "k-off-tier", name: "Off", enabled: 0 });
    const bg = background();
    const tierOf = async (db: D1Database) => {
      try {
        await resolveKey("k-off-tier", db, Date.now(), bg);
      } catch (e) {
        expect(e).toBeInstanceOf(KeyRejectedError);
        return (e as KeyRejectedError).source;
      }
      throw new Error("expected a rejection");
    };

    expect(await tierOf(env.KEYS_DB)).toBe("d1");
    await bg.settled();
    expect(await tierOf(noD1)).toBe("l1");
    __resetKeyCache({ keepL2: true });
    expect(await tierOf(noD1)).toBe("l2");

    __resetKeyCache();
    await expect(resolveKey("k-unknown", env.KEYS_DB)).rejects.toMatchObject({ source: "d1", message: "Invalid API key" });
  });

  it("expires an L1 entry filled from L2 at the L2 entry's expiry, not a fresh TTL", async () => {
    await insert({ apiKey: "k-exp", name: "First" });
    const t0 = 1_000_000;
    const bg = background();
    await validateKey("k-exp", env.KEYS_DB, t0, bg);
    await bg.settled();

    // Another isolate fills L1 from L2 four minutes later.
    __resetKeyCache({ keepL2: true });
    expect((await resolveKey("k-exp", noD1, t0 + 4 * 60_000)).source).toBe("l2");

    await env.KEYS_DB.prepare(
      "UPDATE api_keys SET name = 'Second' WHERE api_key = 'k-exp'",
    ).run();

    // Still cached just before the original read's TTL is up...
    expect((await resolveKey("k-exp", noD1, t0 + KEY_CACHE_TTL_MS - 1)).source).toBe("l1");
    // ...and back to D1 just after it, though L1 was filled only a minute ago.
    const after = await resolveKey("k-exp", env.KEYS_DB, t0 + KEY_CACHE_TTL_MS + 1);
    expect(after.source).toBe("d1");
    expect(after.record.name).toBe("Second");
  });

  it("caches a disabled key in L2 and still rejects it", async () => {
    await insert({ apiKey: "k-off-l2", name: "Off", enabled: 0 });
    const bg = background();
    await expect(validateKey("k-off-l2", env.KEYS_DB, Date.now(), bg)).rejects.toThrow("API key is disabled");
    await bg.settled();

    __resetKeyCache({ keepL2: true });
    await expect(validateKey("k-off-l2", noD1)).rejects.toThrow("API key is disabled");
  });

  it("doesn't cache an unknown key in either tier", async () => {
    const bg = background();
    await expect(validateKey("k-nobody", env.KEYS_DB, Date.now(), bg)).rejects.toThrow("Invalid API key");
    await bg.settled();

    await insert({ apiKey: "k-nobody", name: "Now real" });
    __resetKeyCache({ keepL2: true });
    expect((await validateKey("k-nobody", env.KEYS_DB)).name).toBe("Now real");
  });

  it("falls through to D1 when L2 throws", async () => {
    keyLookup.l2 = () =>
      ({
        match: async () => {
          throw new Error("cache down");
        },
        put: async () => {
          throw new Error("cache down");
        },
        delete: async () => {
          throw new Error("cache down");
        },
      }) as unknown as Cache;
    await insert({ apiKey: "k-fall", name: "Fall" });
    const bg = background();

    const { record, source } = await resolveKey("k-fall", env.KEYS_DB, Date.now(), bg);
    await bg.settled();

    expect(source).toBe("d1");
    expect(record.name).toBe("Fall");
  });

  it("falls through to D1 when L2 stalls", async () => {
    keyLookup.l2TimeoutMs = 20;
    keyLookup.l2 = () =>
      ({
        match: () => new Promise(() => {}),
        put: async () => {},
        delete: async () => false,
      }) as unknown as Cache;
    await insert({ apiKey: "k-stall", name: "Stall" });

    const { source } = await resolveKey("k-stall", env.KEYS_DB);
    expect(source).toBe("d1");
  });

  it("throws KeyLookupTimeoutError when D1 outlasts the bound, and the late read still fills the cache", async () => {
    keyLookup.timeoutMs = 30;
    const { db, settle } = heldD1();
    const bg = background();

    await expect(resolveKey("k-held", db, Date.now(), bg)).rejects.toBeInstanceOf(KeyLookupTimeoutError);

    settle.resolve(ROW);
    await bg.settled();

    // L1 in this isolate...
    expect((await resolveKey("k-held", noD1)).source).toBe("l1");
    // ...and L2 for the next one.
    __resetKeyCache({ keepL2: true });
    expect((await resolveKey("k-held", noD1)).source).toBe("l2");
  });

  it("swallows a D1 failure that lands after the timeout", async () => {
    keyLookup.timeoutMs = 30;
    const { db, settle } = heldD1();
    const bg = background();

    await expect(resolveKey("k-held", db, Date.now(), bg)).rejects.toBeInstanceOf(KeyLookupTimeoutError);
    // An unhandled rejection here would fail the run.
    settle.reject(new Error("D1 overloaded"));
    await bg.settled();
    await scheduler.wait(10);
  });

  it("doesn't re-cache a late read when the key changed in between", async () => {
    // The row in D1 that the admin update will change.
    await insert({ apiKey: "k-held", name: "Held" });
    keyLookup.timeoutMs = 30;
    const { db, settle } = heldD1();
    const bg = background();

    // The read starts, and the request gives up on it.
    await expect(resolveKey("k-held", db, Date.now(), bg)).rejects.toBeInstanceOf(KeyLookupTimeoutError);
    // An admin disables the key...
    expect(await updateKey(env.KEYS_DB, "id-k-held", { enabled: false })).toBe(true);
    // ...then the stale read lands, saying enabled.
    settle.resolve(ROW);
    await bg.settled();

    expect(isKeyCached("k-held")).toBe(false);
    keyLookup.timeoutMs = KEY_LOOKUP_TIMEOUT_MS;
    // Nothing in L2 either: the next lookup reaches D1 and sees the disable.
    await expect(resolveKey("k-held", env.KEYS_DB)).rejects.toMatchObject({ source: "d1", message: "API key is disabled" });
  });

  it("never lets a stalled or failing L2 delete hold or fail a mutation", async () => {
    await insert({ apiKey: "k-a", name: "A" });
    await insert({ apiKey: "k-b", name: "B" });
    keyLookup.l2TimeoutMs = 20;

    keyLookup.l2 = () =>
      ({ match: async () => undefined, put: async () => {}, delete: () => new Promise(() => {}) }) as unknown as Cache;
    expect(await updateKey(env.KEYS_DB, "id-k-a", { name: "A2" })).toBe(true);

    keyLookup.l2 = () =>
      ({
        match: async () => undefined,
        put: async () => {},
        delete: async () => {
          throw new Error("cache down");
        },
      }) as unknown as Cache;
    expect(await deleteKey(env.KEYS_DB, "id-k-b")).toBe(true);
  });

  it("waits for the L2 delete before a mutation returns", async () => {
    await insert({ apiKey: "k-wait", name: "Wait" });
    let deleted = false;
    keyLookup.l2 = () =>
      ({
        match: async () => undefined,
        put: async () => {},
        delete: async () => {
          await scheduler.wait(10);
          deleted = true;
          return true;
        },
      }) as unknown as Cache;

    expect(await updateKey(env.KEYS_DB, "id-k-wait", { enabled: false })).toBe(true);
    // This colo's entry is gone before the admin response can go out.
    expect(deleted).toBe(true);
  });

  it("runs each request's cold lookup on its own", async () => {
    keyLookup.timeoutMs = 30;
    const stalled = heldD1();
    const bg = background();
    // A lookup whose read never settles...
    await expect(resolveKey("k-held", stalled.db, Date.now(), bg)).rejects.toBeInstanceOf(KeyLookupTimeoutError);

    // ...doesn't wedge the key: the next request does its own read.
    const fresh = heldD1();
    const next = resolveKey("k-held", fresh.db, Date.now(), bg);
    fresh.settle.resolve(ROW);
    expect((await next).record.name).toBe("Held");
    expect(fresh.calls.prepare).toBe(1);
  });

  it("drops a key's L2 entry when it is updated", async () => {
    await insert({ apiKey: "k-mut", name: "Mut" });
    const bg = background();
    await validateKey("k-mut", env.KEYS_DB, Date.now(), bg);
    await bg.settled();

    await updateKey(env.KEYS_DB, "id-k-mut", { enabled: false });

    // A fresh isolate in this colo must see the disable, not the cached record.
    __resetKeyCache({ keepL2: true });
    await expect(validateKey("k-mut", env.KEYS_DB)).rejects.toThrow("API key is disabled");
  });

  it("drops a key's L2 entry when it is deleted", async () => {
    await insert({ apiKey: "k-del", name: "Del" });
    const bg = background();
    await validateKey("k-del", env.KEYS_DB, Date.now(), bg);
    await bg.settled();

    expect(await deleteKey(env.KEYS_DB, "id-k-del")).toBe(true);

    __resetKeyCache({ keepL2: true });
    await expect(validateKey("k-del", env.KEYS_DB)).rejects.toThrow("Invalid API key");
  });

  it("still reports whether an update or delete matched a key", async () => {
    expect(await updateKey(env.KEYS_DB, "id-nobody", { name: "x" })).toBe(false);
    expect(await deleteKey(env.KEYS_DB, "id-nobody")).toBe(false);
  });
});

describe("hasScope", () => {
  const base = {
    apiKey: "k",
    keyId: "id",
    name: "n",
    enabled: true,
    retentionDays: 0,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("grants a scope the key holds directly", () => {
    expect(hasScope({ ...base, scopes: ["ingest"] }, "ingest")).toBe(true);
  });

  it("grants lesser scopes to admin via the hierarchy", () => {
    expect(hasScope({ ...base, scopes: ["admin"] }, "read")).toBe(true);
  });

  it("denies a greater scope to an ingest-only key", () => {
    expect(hasScope({ ...base, scopes: ["ingest"] }, "admin")).toBe(false);
  });
});
