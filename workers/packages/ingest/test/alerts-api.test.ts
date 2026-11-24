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

const testEnv = (over: Record<string, string> = {}) => ({
  ...env,
  BASIN_SQL_TOKEN: "t",
  BASIN_SQL_ACCOUNT: "acct",
  BASIN_SQL_BUCKET: "bucket",
  ALERT_LAG_SECONDS: "180",
  ...over,
});

async function call(path: string, key: string | null, method = "GET", body?: unknown, envOver?: Record<string, string>) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (key) headers.set("X-Api-Key", key);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://logs.example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    testEnv(envOver) as never,
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
  for (const t of ["alerts", "alert_destinations", "alert_evaluations", "alert_firings"]) await env.KEYS_DB.prepare(`DELETE FROM ${t}`).run();
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

  it("shows each alert's query volume and its cost at Basin's per-query minimum (refs #194)", async () => {
    const mk = async (interval_seconds: number, enabled = true) =>
      ((await (await call("/api/v1/alerts", "k-write", "POST", { ...ALERT, interval_seconds, enabled })).json()) as { id: string }).id;
    const ids = { s30: await mk(30), s60: await mk(60), s90: await mk(90), s300: await mk(300), off: await mk(60, false) };
    const before = basinQueries.length;
    const list = (await (await call("/api/v1/alerts", "k-read", "GET", undefined, { ALERT_BATCH_MODE: "off" })).json()) as {
      data: { id: string; queries_per_day: number; est_usd_per_month: number }[];
    };
    expect(basinQueries.length).toBe(before);
    const cost = (id: string) => {
      const a = list.data.find((x) => x.id === id)!;
      return [a.queries_per_day, a.est_usd_per_month];
    };
    expect(cost(ids.s30)).toEqual([1440, 1.08]);
    expect(cost(ids.s60)).toEqual([1440, 1.08]);
    expect(cost(ids.s90)).toEqual([720, 0.54]);
    expect(cost(ids.s300)).toEqual([288, 0.216]);
    expect(cost(ids.off)).toEqual([0, 0]);
  });

  it("prices a batchable alert at its share of a batch when ALERT_BATCH_MODE is on (refs #196)", async () => {
    const mk = async (interval_seconds: number, query = ALERT.query) =>
      ((await (await call("/api/v1/alerts", "k-write", "POST", { ...ALERT, query, interval_seconds })).json()) as { id: string }).id;
    // No top-level AS name, so batch.ts can't read its columns: it runs alone.
    const alone = "SELECT count(*) FROM logs.events WHERE source = 'example' AND ts > now() - INTERVAL '5 minutes'";
    const ids = { s60: await mk(60), s300: await mk(300), alone60: await mk(60, alone) };
    const cost = async (mode?: string) => {
      const res = await call("/api/v1/alerts", "k-read", "GET", undefined, mode === undefined ? {} : { ALERT_BATCH_MODE: mode });
      const { data } = (await res.json()) as { data: { id: string; queries_per_day: number; est_usd_per_month: number }[] };
      return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, (({ queries_per_day, est_usd_per_month }) => [queries_per_day, est_usd_per_month])(data.find((x) => x.id === id)!)]));
    };
    expect(await cost("on")).toEqual({ s60: [144, 0.108], s300: [28.8, 0.022], alone60: [1440, 1.08] });
    // off, shadow and unset (shadow) run one query per alert.
    for (const mode of ["off", "shadow", undefined]) {
      expect(await cost(mode)).toEqual({ s60: [1440, 1.08], s300: [288, 0.216], alone60: [1440, 1.08] });
    }
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
  const sent: { url: string; body: string; headers: Headers }[] = [];
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
      sent.push({ url, body: init?.body instanceof FormData ? String(init.body.get("payload")) : String(init?.body), headers: new Headers(init?.headers) });
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
    expect(sent[0].headers.get("X-Token")).toBe("s3cret");
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

describe("alert firing history routes (refs #193)", () => {
  const seed = async () => {
    const { id } = (await (await call("/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    const ins = (alertId: string, at: string, outcome: string) =>
      env.KEYS_DB.prepare(
        "INSERT INTO alert_firings (alert_id, fired_at, values_json, outcome, destinations_json, error) VALUES (?, ?, '{\"cnt\":5}', ?, '[{\"target\":\"webhook:Hook\",\"ok\":true}]', NULL)",
      ).bind(alertId, at, outcome);
    await env.KEYS_DB.batch([
      ins(id, "2026-11-20T10:00:00.000Z", "delivered"),
      ins(id, "2026-11-20T10:01:00.000Z", "cooldown"),
      ins(id, "2026-11-21T09:00:00.000Z", "failed"),
      ins("deleted-alert", "2026-11-21T08:00:00.000Z", "delivered"),
    ]);
    return id;
  };
  type Page = { data: { alert_id: string; alert_name: string | null; fired_at: string; outcome: string; values: unknown; destinations: unknown }[]; meta: { count: number; limit: number } };
  const page = async (path: string, key = "k-read") => {
    const res = await call(path, key);
    return { status: res.status, body: (await res.json()) as Page & { fields?: Record<string, string> } };
  };

  it("lists every alert's firings newest first, parsed, with the alert's name", async () => {
    const id = await seed();
    const { status, body } = await page("/api/v1/alert-firings");
    expect(status).toBe(200);
    expect(body.data.map((f) => [f.alert_id === id ? "a" : f.alert_id, f.outcome])).toEqual([
      ["a", "failed"],
      ["deleted-alert", "delivered"],
      ["a", "cooldown"],
      ["a", "delivered"],
    ]);
    expect(body.data[0]).toMatchObject({ alert_name: "Example Errors", values: { cnt: 5 }, destinations: [{ target: "webhook:Hook", ok: true }] });
    expect(body.data[1].alert_name).toBeNull();
    expect(body.meta).toEqual({ count: 4, limit: 100 });
  });

  it("one alert's firings, filtered by from/to (ISO or epoch ms) and limit; /v2 answers the same", async () => {
    const id = await seed();
    const one = await page(`/api/v1/alerts/${id}/firings`);
    expect(one.body.data.map((f) => f.outcome)).toEqual(["failed", "cooldown", "delivered"]);
    const ms = Date.parse("2026-11-20T10:00:30Z");
    const window = await page(`/api/v1/alerts/${id}/firings?from=${ms}&to=2026-11-21T00:00:00Z`);
    expect(window.body.data.map((f) => f.fired_at)).toEqual(["2026-11-20T10:01:00.000Z"]);
    const limited = await page(`/api/v1/alert-firings?limit=2`);
    expect(limited.body.data).toHaveLength(2);
    expect(limited.body.meta.limit).toBe(2);
    expect((await page(`/api/v1/alert-firings?limit=5000`)).body.meta.limit).toBe(1000);
    expect((await page(`/v2/api/v1/alerts/${id}/firings`)).body).toEqual(one.body);
    expect((await page(`/v2/api/v1/alert-firings`)).body).toEqual((await page(`/api/v1/alert-firings`)).body);
  });

  it("400s on a bad from, to or limit; 404s an unknown alert; read scope like GET /api/v1/alerts", async () => {
    await seed();
    for (const q of ["from=yesterday", "to=2026-13-45", "from=2026-11-21&to=2026-11-20", "limit=0", "limit=abc"]) {
      const r = await page(`/api/v1/alert-firings?${q}`);
      expect(r.status, q).toBe(400);
    }
    expect((await page("/api/v1/alert-firings?from=yesterday")).body.fields).toEqual({ from: "Must be an ISO 8601 time or epoch milliseconds" });
    expect((await page("/api/v1/alerts/00000000-0000-0000-0000-000000000000/firings")).status).toBe(404);
    expect((await page("/api/v1/alert-firings", "k-ingest")).status).toBe(403);
    expect((await call("/api/v1/alert-firings", null)).status).toBe(401);
    expect((await call("/api/v1/alert-firings", "k-write", "POST", {})).status).toBe(405);
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

  it("hides webhook header values from read keys and shows them to write keys", async () => {
    const config = { url: "https://hook.example.com/x", headers: { "X-Token": "s3cret", "X-Env": "prod" } };
    const res = await call("/v2/api/v1/alert-destinations", "k-write", "POST", { name: "Hook", type: "webhook", config });
    const { id } = (await res.json()) as { id: string };
    const configFor = async (key: string) =>
      ((await (await call("/v2/api/v1/alert-destinations", key)).json()) as { data: { id: string; config: unknown }[] }).data.find((d) => d.id === id)?.config;

    const read = await configFor("k-read");
    expect(read).toEqual({ url: "https://hook.example.com/x", headers: { "X-Token": "********", "X-Env": "********" } });
    expect(JSON.stringify(read)).not.toContain("s3cret");
    expect(await configFor("k-write")).toEqual(config);
    await call("/v2/api/v1/alert-destinations", "k-write", "DELETE", { id });
  });
});

describe("MCP alert tools", () => {
  const rpc = async (key: string, name: string, args: Record<string, unknown>, envOver?: Record<string, string>) =>
    (await (await call("/v2/api/mcp", key, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, envOver)).json()) as {
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

  const text = (r: Awaited<ReturnType<typeof rpc>>) => JSON.parse(r.result!.content[0].text);

  it("list_alerts returns GET /api/v1/alerts' shape, with no destination config", async () => {
    const hook = (await (
      await call("/v2/api/v1/alert-destinations", "k-write", "POST", { name: "Hook", type: "webhook", config: { url: "https://hook.example.com/x", headers: { "X-Token": "s3cret" } } })
    ).json()) as { id: string };
    await call("/api/v1/alerts", "k-write", "POST", { ...ALERT, destination_ids: [hook.id] });
    const res = await rpc("k-read", "list_alerts", {});
    expect(text(res)).toEqual((await (await call("/api/v1/alerts", "k-read")).json()) as unknown);
    expect(res.result!.content[0].text).not.toContain("s3cret");
    expect(res.result!.content[0].text).not.toContain("hook.example.com");
    expect((await rpc("k-ingest", "list_alerts", {})).error?.code).toBe(-32602);
  });

  it("list_alerts prices a batchable alert at its batch share when ALERT_BATCH_MODE is on (refs #196)", async () => {
    await call("/api/v1/alerts", "k-write", "POST", { ...ALERT, interval_seconds: 60 });
    const [on] = text(await rpc("k-read", "list_alerts", {}, { ALERT_BATCH_MODE: "on" })).data;
    expect([on.queries_per_day, on.est_usd_per_month]).toEqual([144, 0.108]);
    const [off] = text(await rpc("k-read", "list_alerts", {}, { ALERT_BATCH_MODE: "off" })).data;
    expect([off.queries_per_day, off.est_usd_per_month]).toEqual([1440, 1.08]);
  });

  it("update_alert disables and re-enables, validates like PATCH, and needs write scope", async () => {
    const { id } = (await (await call("/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    const enabled = async () => (await env.KEYS_DB.prepare("SELECT enabled FROM alerts WHERE id = ?").bind(id).first<{ enabled: number }>())?.enabled;

    expect((await rpc("k-read", "update_alert", { id, enabled: false })).error?.code).toBe(-32602);
    expect(await enabled()).toBe(1);

    expect(text(await rpc("k-write", "update_alert", { id, enabled: false }))).toEqual({ success: true });
    expect(await enabled()).toBe(0);
    expect(text(await rpc("k-write", "update_alert", { id, enabled: true, cooldown_seconds: 900 }))).toEqual({ success: true });
    expect(await env.KEYS_DB.prepare("SELECT enabled, cooldown_seconds FROM alerts WHERE id = ?").bind(id).first()).toEqual({ enabled: 1, cooldown_seconds: 900 });

    const bad = await rpc("k-write", "update_alert", { id, interval_seconds: 5 });
    expect(bad.error).toMatchObject({ code: -32602, message: "interval_seconds: Must be an integer >= 30" });
    const missing = await rpc("k-write", "update_alert", { id: "nope", name: "x" });
    expect(missing.result).toMatchObject({ isError: true });
    expect((await rpc("k-write", "update_alert", {})).error?.code).toBe(-32602);
  });

  it("test_alert runs as REST's test does; deliver needs write scope", async () => {
    const { id } = (await (await call("/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    expect(text(await rpc("k-read", "test_alert", { id }))).toMatchObject({ data: [{ cnt: 5 }], meta: { condition: "cnt > 3", would_fire: true } });
    const refused = await rpc("k-read", "test_alert", { id, deliver: true });
    expect(refused.result).toMatchObject({ isError: true });
    expect(refused.result!.content[0].text).toMatch(/write/);
    expect((await rpc("k-ingest", "test_alert", { id })).error?.code).toBe(-32602);
  });

  it("get_alert_history reads the firing routes, for one alert or all", async () => {
    const { id } = (await (await call("/api/v1/alerts", "k-write", "POST", ALERT)).json()) as { id: string };
    await env.KEYS_DB.batch([
      env.KEYS_DB.prepare("INSERT INTO alert_firings (alert_id, fired_at, outcome) VALUES (?, '2026-11-20T10:00:00.000Z', 'delivered')").bind(id),
      env.KEYS_DB.prepare("INSERT INTO alert_firings (alert_id, fired_at, outcome) VALUES ('other', '2026-11-21T10:00:00.000Z', 'failed')"),
    ]);
    expect(text(await rpc("k-read", "get_alert_history", {})).data.map((f: { alert_id: string }) => f.alert_id)).toEqual(["other", id]);
    const one = text(await rpc("k-read", "get_alert_history", { alert_id: id, from: Date.parse("2026-11-01T00:00:00Z"), limit: 10 }));
    expect(one).toMatchObject({ data: [{ alert_id: id, outcome: "delivered", alert_name: "Example Errors" }], meta: { count: 1, limit: 10 } });
    expect((await rpc("k-read", "get_alert_history", { from: "last week" })).error?.code).toBe(-32602);
    expect((await rpc("k-ingest", "get_alert_history", {})).error?.code).toBe(-32602);
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
