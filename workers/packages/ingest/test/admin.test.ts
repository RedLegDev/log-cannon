import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetKeyCache } from "../src/keys";

async function seed(apiKey: string, scopes: string) {
  await env.KEYS_DB.prepare(
    `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
     VALUES (?, ?, ?, 1, ?, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(apiKey, `id-${apiKey}`, `name-${apiKey}`, scopes)
    .run();
}

describe("/v1/keys", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await seed("admin-key", "admin");
    await seed("ingest-key", "ingest");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await SELF.fetch("https://x/v1/keys");
    expect(res.status).toBe(401);
  });

  it("rejects an ingest-scoped key", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      headers: { "X-Api-Key": "ingest-key" },
    });
    expect(res.status).toBe(403);
  });

  it("lists keys for an admin key", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      headers: { "X-Api-Key": "admin-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(2);
  });

  it("creates a key that immediately authenticates ingest", async () => {
    const created = await SELF.fetch("https://x/v1/keys", {
      method: "POST",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Service", scopes: "ingest" }),
    });
    expect(created.status).toBe(201);
    const { apiKey } = (await created.json()) as { apiKey: string };

    // This is the regression test for the original dual-store bug.
    const ingested = await SELF.fetch("https://x/ingest/clef", {
      method: "POST",
      headers: { "X-Seq-ApiKey": apiKey, "Content-Type": "application/json" },
      body: '{"@t":"2026-08-06T00:00:00Z","@mt":"hello"}',
    });
    // 201 with {"MinimumLevelAccepted":null} is the Seq API contract for a
    // successful CLEF ingest — see handleCLEF. Not 200.
    expect(ingested.status).toBe(201);
  });

  it("rejects an invalid scope on create", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      method: "POST",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", scopes: "root" }),
    });
    expect(res.status).toBe(400);
  });

  it("disables a key via PATCH", async () => {
    const res = await SELF.fetch("https://x/v1/keys/id-ingest-key", {
      method: "PATCH",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const row = await env.KEYS_DB.prepare(
      "SELECT enabled FROM api_keys WHERE key_id = 'id-ingest-key'",
    ).first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("deletes a key", async () => {
    const res = await SELF.fetch("https://x/v1/keys/id-ingest-key", {
      method: "DELETE",
      headers: { "X-Api-Key": "admin-key" },
    });
    expect(res.status).toBe(200);

    const row = await env.KEYS_DB.prepare(
      "SELECT enabled FROM api_keys WHERE key_id = 'id-ingest-key'",
    ).first();
    expect(row).toBeNull();
  });
});
