import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { validateKey, hasScope, __resetKeyCache } from "../src/keys";

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
