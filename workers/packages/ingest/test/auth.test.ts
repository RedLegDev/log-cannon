import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetKeyCache,
  keyLookup,
  KEY_LOOKUP_RETRY_AFTER_S,
  KEY_LOOKUP_TIMEOUT_MS,
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

  it("accepts apiKey from the query string (sendBeacon clients)", async () => {
    await insert({ apiKey: "k-query", name: "Beacon" });

    const res = await SELF.fetch(
      "https://logs.example.com/ingest/clef?apiKey=k-query",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: CLEF_BODY,
      },
    );
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

// refs #151: a key lookup that runs out of time is the key store's fault, not
// the sender's, so every surface that authenticates answers 503 with
// Retry-After rather than a terminal 401/403. A zero budget makes the lookup
// time out deterministically, before D1 can answer.
describe("authenticate when the key lookup times out", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await insert({ apiKey: "k-admin", name: "Admin", scopes: "admin" });
    keyLookup.timeoutMs = 0;
  });

  afterEach(() => {
    keyLookup.timeoutMs = KEY_LOOKUP_TIMEOUT_MS;
  });

  function expect503(res: Response) {
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(KEY_LOOKUP_RETRY_AFTER_S));
  }

  it("answers an ingest request with 503 and Retry-After", async () => {
    expect503(await postCLEF({ "X-Api-Key": "k-admin" }));
  });

  it("answers the read API with 503 and Retry-After", async () => {
    const res = await SELF.fetch("https://logs.example.com/api/v1/logs", {
      headers: { "X-Api-Key": "k-admin" },
    });
    expect503(res);
    expect(((await res.json()) as { error: string }).error).toBe("unavailable");
  });

  it("answers MCP with 503 and Retry-After", async () => {
    expect503(
      await SELF.fetch("https://logs.example.com/api/mcp", {
        method: "POST",
        headers: { "X-Api-Key": "k-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
  });

  it("answers the admin key API with 503 and Retry-After", async () => {
    expect503(
      await SELF.fetch("https://logs.example.com/v1/keys", {
        headers: { "X-Api-Key": "k-admin" },
      }),
    );
  });

  it("still answers a cached key without waiting on D1", async () => {
    keyLookup.timeoutMs = KEY_LOOKUP_TIMEOUT_MS;
    expect((await postCLEF({ "X-Api-Key": "k-admin" })).status).toBe(201);

    keyLookup.timeoutMs = 0;
    expect((await postCLEF({ "X-Api-Key": "k-admin" })).status).toBe(201);
  });

  it("leaves a missing key at 401", async () => {
    expect((await postCLEF()).status).toBe(401);
  });
});
