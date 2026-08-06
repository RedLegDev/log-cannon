import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetKeyCache } from "../src/keys";

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

const CLEF_BODY = `${JSON.stringify({ "@t": "2026-01-01T00:00:00Z", "@mt": "hello" })}\n`;

function postCLEF(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch("https://logs.example.com/ingest/clef", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: CLEF_BODY,
  });
}

describe("authenticate", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  });

  it("returns 401 when no API key is supplied", async () => {
    const res = await postCLEF();
    expect(res.status).toBe(401);
  });

  it("returns 403 for an unknown API key", async () => {
    const res = await postCLEF({ "X-Api-Key": "k-missing" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for a disabled API key", async () => {
    await insert({ apiKey: "k-off", name: "Old", enabled: 0 });

    const res = await postCLEF({ "X-Api-Key": "k-off" });
    expect(res.status).toBe(403);
  });

  it("returns 200-range success for a valid enabled key", async () => {
    await insert({ apiKey: "k-good", name: "Readerful" });

    const res = await postCLEF({ "X-Api-Key": "k-good" });
    expect(res.status).toBe(201);
  });

  it("returns 500 (not 403) when the key store itself is unavailable", async () => {
    await insert({ apiKey: "k-good", name: "Readerful" });
    // Ensure the cache doesn't mask the outage by serving a stale hit.
    __resetKeyCache();

    // Simulate a D1 failure: the underlying table is temporarily gone, so
    // validateKey's query throws something other than the two known auth
    // errors. Always restore the table so later tests aren't affected.
    await env.KEYS_DB.prepare(
      "ALTER TABLE api_keys RENAME TO api_keys_backup",
    ).run();

    try {
      const res = await postCLEF({ "X-Api-Key": "k-good" });
      expect(res.status).toBe(500);
    } finally {
      await env.KEYS_DB.prepare(
        "ALTER TABLE api_keys_backup RENAME TO api_keys",
      ).run();
    }
  });
});
