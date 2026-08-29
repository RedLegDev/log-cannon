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

describe("readBody error mapping", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await insert({ apiKey: "k-good", name: "Readerful" });
  });

  it("returns 400 (not 500) when Content-Encoding is gzip but the body is raw JSON", async () => {
    const res = await SELF.fetch("https://logs.example.com/ingest/clef", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "X-Api-Key": "k-good",
      },
      body: CLEF_BODY,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 or 201 (never 500) for an empty POST with a valid key", async () => {
    const res = await SELF.fetch("https://logs.example.com/ingest/clef", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": "k-good",
      },
      body: "",
    });
    expect(res.status).not.toBe(500);
    expect([201, 400]).toContain(res.status);
  });

  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("https://logs.example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
