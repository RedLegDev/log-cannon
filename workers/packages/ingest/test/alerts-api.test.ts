// /v2/api/v1/alerts, /v2/api/v1/alert-destinations and the MCP alert tools
// through the fetch handler (refs #165). Basin SQL is a mocked fetch.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

const KEYS: [string, string][] = [
  ["k-ingest", "ingest"],
  ["k-read", "read"],
  ["k-write", "write"],
];

let basinQueries: string[];

const testEnv = () => ({
  ...env,
  INGEST_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  BASIN_SQL_TOKEN: "t",
  BASIN_SQL_ACCOUNT: "acct",
  BASIN_SQL_BUCKET: "bucket",
  ALERT_LAG_SECONDS: "180",
});

async function call(path: string, key: string | null, method = "GET", body?: unknown) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (key) headers.set("X-Api-Key", key);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://logs.example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    testEnv() as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const ALERT = {
  name: "Example Errors",
  query: "SELECT count(*) AS cnt FROM logs.events WHERE source = 'example' AND level = 'Error' AND ts > now() - INTERVAL '5 minutes'",
  condition: "cnt > 3",
  subject: "Example errors",
  recipients: ["ops@example.com"],
};

beforeEach(async () => {
  __resetKeyCache();
  __resetTelemetryThrottle();
  await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  for (const t of ["alerts", "alert_destinations", "alert_evaluations"]) await env.KEYS_DB.prepare(`DELETE FROM ${t}`).run();
  for (const [k, scopes] of KEYS) {
    await env.KEYS_DB.prepare(
      "INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES (?, ?, ?, 1, ?, 0, '2026-01-01T00:00:00Z')",
    )
      .bind(k, `id-${k}`, `app-${k}`, scopes)
      .run();
  }
  basinQueries = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    basinQueries.push(JSON.parse(String(init?.body)).query);
    return new Response(JSON.stringify({ success: true, result: { rows: [{ cnt: 5 }], metrics: { bytes_scanned: 1 } } }));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("/v2/api/v1/alerts", () => {
  it("reads need a read key; changes need a write key", async () => {
    expect((await call("/v2/api/v1/alerts", null)).status).toBe(401);
    expect((await call("/v2/api/v1/alerts", "k-ingest")).status).toBe(403);
    expect((await call("/v2/api/v1/alerts", "k-read")).status).toBe(200);
    const denied = await call("/v2/api/v1/alerts", "k-read", "POST", ALERT);
    expect(denied.status).toBe(403);
    expect((await call("/v2/api/v1/alerts", "k-write", "POST", ALERT)).status).toBe(201);
  });

  it("creates with v1's defaults and lists v1's shape plus the latest evaluation", async () => {
    const created = (await (await call("/v2/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    const list = (await (await call("/v2/api/v1/alerts", "k-read")).json()) as { data: Record<string, unknown>[] };
    expect(list.data).toEqual([
      expect.objectContaining({
        id: created.id,
        name: "Example Errors",
        description: "",
        interval_seconds: 60,
        cooldown_seconds: 300,
        recipients: ["ops@example.com"],
        destination_ids: [],
        enabled: true,
        last_triggered_at: null,
        last_status: null,
        last_value: null,
      }),
    ]);
  });

  it("validates like v1, field by field", async () => {
    const res = await call("/v2/api/v1/alerts", "k-write", "POST", { ...ALERT, query: "DELETE FROM x", interval_seconds: 10, recipients: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(Object.keys(body.fields).sort()).toEqual(["destination_ids", "interval_seconds", "query"]);
  });

  it("keeps a caller-chosen id (the v1 import) and refuses a duplicate", async () => {
    const id = "c9a81e68-c318-4e0c-bd63-3c87b772535a";
    expect((await call("/v2/api/v1/alerts", "k-write", "POST", { ...ALERT, id, enabled: false })).status).toBe(201);
    expect((await call("/v2/api/v1/alerts", "k-write", "POST", { ...ALERT, id })).status).toBe(409);
    expect((await call("/v2/api/v1/alerts", "k-write", "POST", { ...ALERT, id: "not-a-uuid" })).status).toBe(400);
    const row = await env.KEYS_DB.prepare("SELECT enabled FROM alerts WHERE id = ?").bind(id).first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("patches only the named fields, and deletes", async () => {
    const { id } = (await (await call("/v2/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    expect((await call("/v2/api/v1/alerts", "k-write", "PATCH", { id, condition: "cnt > 10" })).status).toBe(200);
    expect((await call("/v2/api/v1/alerts", "k-write", "PATCH", { id, cooldown_seconds: -1 })).status).toBe(400);
    const row = await env.KEYS_DB.prepare("SELECT condition, name FROM alerts WHERE id = ?").bind(id).first();
    expect(row).toEqual({ condition: "cnt > 10", name: "Example Errors" });
    expect((await call("/v2/api/v1/alerts", "k-write", "PATCH", { id: "missing", name: "x" })).status).toBe(404);
    expect((await call("/v2/api/v1/alerts", "k-write", "DELETE", { id })).status).toBe(200);
    expect((await call("/v2/api/v1/alerts", "k-write", "DELETE", { id })).status).toBe(404);
  });

  it("test runs the query as the evaluator would and says whether it fires", async () => {
    const { id } = (await (await call("/v2/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    const res = await call(`/v2/api/v1/alerts/${id}/test`, "k-read", "POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, unknown> };
    expect(body.data).toEqual([{ cnt: 5 }]);
    expect(body.meta).toMatchObject({ condition: "cnt > 3", would_fire: true });
    expect(basinQueries[0]).toMatch(/ts > TIMESTAMP '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ' - INTERVAL '5 minutes'$/);
    const draft = await call(`/v2/api/v1/alerts/${id}/test`, "k-read", "POST", { query: "SELECT 1 AS cnt FROM logs.events", condition: "cnt > 3" });
    expect(((await draft.json()) as { meta: Record<string, unknown> }).meta.would_fire).toBe(true);
  });
});

describe("/v2/api/v1/alerts/:id/test deliver", () => {
  const sent: { url: string; body: string }[] = [];
  const deliverEnv = () => ({ ...testEnv(), SAASMAIL_API_KEY: "mailkey", SAASMAIL_API_URL: "https://mail.example.com", ALERT_FROM_EMAIL: "alerts@example.com" });
  const deliverCall = async (id: string, key: string, body: unknown) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://logs.example.com/v2/api/v1/alerts/${id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": key },
        body: JSON.stringify(body),
      }),
      deliverEnv() as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };

  beforeEach(() => {
    sent.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("cloudflarestorage.com")) {
        basinQueries.push(JSON.parse(String(init?.body)).query);
        return new Response(JSON.stringify({ success: true, result: { rows: [{ cnt: 0 }], metrics: { bytes_scanned: 1 } } }));
      }
      sent.push({ url, body: init?.body instanceof FormData ? String(init.body.get("payload")) : String(init?.body) });
      return new Response("ok");
    });
  });

  it("sends to the alert's destinations even when it would not fire, and leaves the cooldown alone", async () => {
    const hook = (await (
      await call("/v2/api/v1/alert-destinations", "k-write", "POST", { name: "Hook", type: "webhook", config: { url: "https://hook.example.com/x", headers: { "X-Token": "s3cret" } } })
    ).json()) as { id: string };
    const { id } = (await (await call("/v2/api/v1/alerts", "k-write", "POST", { ...ALERT, destination_ids: [hook.id] })).json()) as { id: string };

    expect((await deliverCall(id, "k-read", { deliver: true })).status).toBe(403);
    expect(sent).toEqual([]);

    const res = await deliverCall(id, "k-write", { deliver: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: Record<string, unknown> };
    expect(body.meta).toMatchObject({ would_fire: false, delivery: { delivered: 1, attempts: [{ target: "webhook:Hook", ok: true }] } });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ alert_id: id, query_result: { cnt: 0 } });
    const row = await env.KEYS_DB.prepare("SELECT last_triggered_at, shadow_last_triggered_at FROM alerts WHERE id = ?").bind(id).first();
    expect(row).toEqual({ last_triggered_at: null, shadow_last_triggered_at: null });
  });

  it("emails the recipients with a [Test] subject, and needs a stored alert", async () => {
    const { id } = (await (await call("/v2/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    const res = await deliverCall(id, "k-write", { deliver: true });
    expect(((await res.json()) as { meta: { delivery: unknown } }).meta.delivery).toMatchObject({ delivered: 1 });
    expect(sent[0].url).toBe("https://mail.example.com/api/send");
    expect(JSON.parse(sent[0].body)).toMatchObject({ to: "ops@example.com", fromAddress: "alerts@example.com", subject: "[Test] Example errors" });
    expect((await deliverCall("00000000-0000-0000-0000-000000000000", "k-write", { deliver: true, query: "SELECT 1 AS cnt" })).status).toBe(404);
  });
});

describe("/v2/api/v1/alert-destinations", () => {
  it("creates, lists with parsed config, patches and deletes", async () => {
    const bad = await call("/v2/api/v1/alert-destinations", "k-write", "POST", { name: "Mail", type: "email", config: {} });
    expect(bad.status).toBe(400);
    const res = await call("/v2/api/v1/alert-destinations", "k-write", "POST", { name: "Mail", type: "email", config: { email: "ops@example.com" } });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = (await (await call("/v2/api/v1/alert-destinations", "k-read")).json()) as { data: Record<string, unknown>[] };
    expect(list.data).toEqual([expect.objectContaining({ id, name: "Mail", type: "email", config: { email: "ops@example.com" }, enabled: true })]);
    expect((await call("/v2/api/v1/alert-destinations", "k-read", "PATCH", { id, enabled: false })).status).toBe(403);
    expect((await call("/v2/api/v1/alert-destinations", "k-write", "PATCH", { id, enabled: false })).status).toBe(200);
    expect((await call("/v2/api/v1/alert-destinations", "k-write", "DELETE", { id })).status).toBe(200);
  });
});

describe("MCP alert tools", () => {
  const rpc = async (key: string, name: string, args: Record<string, unknown>) =>
    (await (await call("/v2/api/mcp", key, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as {
      result?: { content: { text: string }[]; isError?: boolean };
      error?: { code: number; message: string };
    };

  it("create_alert needs write scope and validates like the API", async () => {
    expect((await rpc("k-read", "create_alert", ALERT)).error?.code).toBe(-32602);
    expect((await rpc("k-write", "create_alert", { ...ALERT, condition: undefined })).error?.message).toMatch(/condition/);
    const ok = await rpc("k-write", "create_alert", ALERT);
    expect(JSON.parse(ok.result!.content[0].text)).toMatchObject({ success: true });
    expect((await env.KEYS_DB.prepare("SELECT count(*) AS n FROM alerts").first<{ n: number }>())?.n).toBe(1);
  });

  it("get_firing_alerts lists alerts inside their cooldown, live and shadow apart", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    await env.KEYS_DB.batch([
      env.KEYS_DB.prepare(
        "INSERT INTO alerts (id, name, query, condition, created_at, updated_at, last_triggered_at) VALUES ('a', 'Live one', 'SELECT 1', 'x > 0', '', '', ?)",
      ).bind(recent),
      env.KEYS_DB.prepare(
        "INSERT INTO alerts (id, name, query, condition, created_at, updated_at, shadow_last_triggered_at) VALUES ('b', 'Shadow one', 'SELECT 1', 'x > 0', '', '', ?)",
      ).bind(recent),
      env.KEYS_DB.prepare(
        "INSERT INTO alerts (id, name, query, condition, created_at, updated_at, last_triggered_at) VALUES ('c', 'Old one', 'SELECT 1', 'x > 0', '', '', ?)",
      ).bind(stale),
    ]);
    const out = JSON.parse((await rpc("k-read", "get_firing_alerts", {})).result!.content[0].text);
    expect(out.data.map((a: { name: string }) => a.name)).toEqual(["Live one"]);
    expect(out.firing_count).toBe(1);
    expect(out.shadow_firing.map((a: { name: string }) => a.name)).toEqual(["Shadow one"]);
  });
});
