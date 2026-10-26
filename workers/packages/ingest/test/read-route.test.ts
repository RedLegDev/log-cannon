// The v2 read API through the fetch handler: auth and scope, the /v2 prefix,
// error mapping, and MCP over JSON-RPC. Basin SQL is a mocked fetch.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { readPath } from "../src/index";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

const KEYS: [string, string, string][] = [
  ["k-ingest", "ingest-app", "ingest"],
  ["k-read", "reader", "read"],
  ["k-write", "writer", "write"],
];

interface Sent {
  queue: { source: string; body: string }[];
  logs: Record<string, unknown>[];
  basin: string[];
}

function harness(extra: Record<string, string> = {}) {
  const sent: Sent = { queue: [], logs: [], basin: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const query = JSON.parse(String(init?.body)).query as string;
    sent.basin.push(query);
    if (query.includes("countIf")) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 40003, message: "Invalid function 'countif'" }] }), { status: 400 });
    }
    return new Response(
      JSON.stringify({
        success: true,
        result: { rows: [{ id: "1", ts: "2026-10-23T12:00:00Z", level: "Error", message: "m", source: "A", properties: '{"k":"v"}' }], metrics: { bytes_scanned: 7 } },
      }),
    );
  });
  const testEnv = {
    ...env,
    INGEST_QUEUE: { send: async (m: { source: string; body: string }) => void sent.queue.push(m), sendBatch: async () => {} },
    LOGS: { send: async (rows: Record<string, unknown>[]) => void sent.logs.push(...rows) },
    BASIN_WRITE: "true",
    QUEUE_ACK_DEADLINE_MS: "0",
    BASIN_SQL_TOKEN: "t",
    BASIN_SQL_ACCOUNT: "acct",
    BASIN_SQL_BUCKET: "bucket",
    ...extra,
  };
  const call = async (path: string, init: RequestInit & { key?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("X-Api-Key", init.key);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://logs.example.com${path}`, { ...init, headers }), testEnv as never, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const rpc = async (key: string, body: unknown) =>
    call("/v2/api/mcp", { method: "POST", key, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return { sent, call, rpc };
}

beforeEach(async () => {
  __resetKeyCache();
  __resetTelemetryThrottle();
  await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  for (const [k, name, scopes] of KEYS) {
    await env.KEYS_DB.prepare(
      "INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES (?, ?, ?, 1, ?, 0, '2026-01-01T00:00:00Z')",
    )
      .bind(k, `id-${k}`, name, scopes)
      .run();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("readPath", () => {
  it("serves only the read routes, unprefixed and under /v2", () => {
    expect(readPath("/v2/api/v1/query")).toBe("/api/v1/query");
    expect(readPath("/v2/api/mcp")).toBe("/api/mcp");
    expect(readPath("/v2/ingest/clef")).toBeNull();
    expect(readPath("/ingest/clef")).toBeNull();
    expect(readPath("/v1/logs")).toBeNull();
    expect(readPath("/v2/v2/api/v1/query")).toBeNull();
    for (const p of ["/api/v1/query", "/api/v1/logs", "/api/mcp", "/api/v1/alerts", "/api/v1/alert-destinations", "/api/v1/alerts/abc/test"]) {
      expect(readPath(p)).toBe(p);
      expect(readPath(`/v2${p}`)).toBe(p);
    }
    expect(readPath("/api/v1/keys")).toBeNull();
    expect(readPath("/api/v1/alerts/abc")).toBeNull();
    expect(readPath("/v2/api/v1/alerts")).toBe("/api/v1/alerts");
    expect(readPath("/v2/api/v1/alerts/abc/test")).toBe("/api/v1/alerts/abc/test");
    expect(readPath("/v2/api/v1/alerts/abc")).toBeNull();
    expect(readPath("/v2/api/v1/alert-destinations")).toBe("/api/v1/alert-destinations");
    expect(readPath("/v2/api/v1/keys")).toBeNull();
  });
});

describe("unprefixed read paths", () => {
  // Each pair goes through the fetch handler; the same handler answers both.
  const cases: [string, RequestInit & { key?: string }][] = [
    ["/api/v1/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }), key: "k-read" }],
    ["/api/v1/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }), key: "k-ingest" }],
    ["/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), key: "k-read" }],
    ["/api/v1/alerts", { key: "k-read" }],
    ["/api/v1/alert-destinations", { key: "k-read" }],
    ["/api/v1/alerts", { key: "k-ingest" }],
  ];
  for (const [path, init] of cases) {
    it(`${init.method ?? "GET"} ${path} (${init.key}) answers as /v2${path} does`, async () => {
      const h = harness();
      const bare = await h.call(path, init);
      const aliased = await h.call(`/v2${path}`, init);
      expect(bare.status).toBe(aliased.status);
      // elapsed_ms is wall time, so it's the one field the two may not share.
      const body = async (r: Response) => {
        const b = (await r.json()) as { meta?: Record<string, unknown> };
        delete b.meta?.elapsed_ms;
        return b;
      };
      expect(await body(bare)).toEqual(await body(aliased));
      // Both sent the same SQL, or neither sent any.
      expect(h.sent.basin.slice(0, 1)).toEqual(h.sent.basin.slice(1));
    });
  }
});

describe("/v2/api/v1/query", () => {
  const post = (sql: unknown) => ({ method: "POST", body: JSON.stringify({ sql }) });

  it("needs a key, and a key with read scope", async () => {
    const h = harness();
    expect((await h.call("/v2/api/v1/query", post("SELECT 1"))).status).toBe(401);
    expect((await h.call("/v2/api/v1/query", { ...post("SELECT 1"), key: "k-nope" })).status).toBe(403);
    const res = await h.call("/v2/api/v1/query", { ...post("SELECT 1"), key: "k-ingest" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(h.sent.basin).toHaveLength(0);
  });

  it("runs a read query with the row cap and returns data and meta", async () => {
    const h = harness();
    const res = await h.call("/v2/api/v1/query", { ...post("SELECT * FROM logs.events"), key: "k-read" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, number> };
    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({ rows: 1, bytes_scanned: 7 });
    expect(h.sent.basin).toEqual(["SELECT * FROM logs.events\nLIMIT 10000"]);
  });

  it("rejects a non-SELECT without calling Basin", async () => {
    const h = harness();
    const res = await h.call("/v2/api/v1/query", { ...post("DROP TABLE logs.events"), key: "k-read" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "validation_error" });
    expect(h.sent.basin).toHaveLength(0);
  });

  it("returns Basin's error with dialect hints for ClickHouse SQL", async () => {
    const h = harness();
    const res = await h.call("/v2/api/v1/query", { ...post("SELECT countIf(level = 'Error') FROM logs.events"), key: "k-read" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string; hints: string[] };
    expect(body.error).toBe("query_error");
    expect(body.message).toContain("countif");
    expect(body.hints[0]).toContain("FILTER (WHERE");
  });
});

describe("/v2/api/v1/logs", () => {
  it("searches with the URL's filters and shapes rows", async () => {
    const h = harness();
    const res = await h.call("/v2/api/v1/logs?source=A&level=Error&prop.k=v&limit=5", { key: "k-read" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[]; meta: Record<string, number> };
    expect(body.data[0].properties).toEqual({ k: "v" });
    expect(body.meta).toMatchObject({ count: 1, limit: 5, bytes_scanned: 7 });
    expect(h.sent.basin[0]).toMatch(/source = 'A' AND level = 'Error' AND CASE WHEN octet_length/);
  });

  it("adds v1's timestamp beside ts on the unprefixed path only", async () => {
    const h = harness();
    const v1 = (await (await h.call("/api/v1/logs?source=A&level=Error&prop.k=v&limit=5", { key: "k-read" })).json()) as {
      data: Record<string, unknown>[];
    };
    const v2 = (await (await h.call("/v2/api/v1/logs?source=A&level=Error&prop.k=v&limit=5", { key: "k-read" })).json()) as {
      data: Record<string, unknown>[];
    };
    expect(v1.data[0]).toMatchObject({ ts: "2026-10-23T12:00:00Z", timestamp: "2026-10-23T12:00:00Z" });
    expect(v2.data[0].ts).toBe("2026-10-23T12:00:00Z");
    expect(v2.data[0]).not.toHaveProperty("timestamp");
    // Same handler: identical SQL, and identical rows apart from the alias.
    expect(h.sent.basin[0]).toBe(h.sent.basin[1]);
    const { timestamp: _, ...rest } = v1.data[0];
    expect(rest).toEqual(v2.data[0]);
  });

  it("refuses DELETE: Basin is read-only", async () => {
    const h = harness();
    const res = await h.call("/v2/api/v1/logs?source=A", { method: "DELETE", key: "k-write" });
    expect(res.status).toBe(405);
  });
});

describe("/v2/api/mcp", () => {
  it("initializes, echoing a supported protocol version", async () => {
    const h = harness();
    const res = await h.rpc("k-read", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("accepts a notification with 202 and no body", async () => {
    const h = harness();
    const res = await h.rpc("k-read", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("lists tools by scope: ingest gets create_log only", async () => {
    const h = harness();
    const list = async (key: string) =>
      ((await (await h.rpc(key, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (t) => t.name,
      );
    expect(await list("k-ingest")).toEqual(["create_log"]);
    expect(await list("k-read")).toEqual(["create_log", "search_logs", "execute_query", "get_overview", "get_firing_alerts", "get_docs"]);
    expect(await list("k-write")).toContain("create_alert");
    expect(await list("k-read")).not.toContain("create_alert");
  });

  it("won't run a tool the key can't see", async () => {
    const h = harness();
    const res = await h.rpc("k-ingest", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_query", arguments: { sql: "SELECT 1" } } });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
    expect(h.sent.basin).toHaveLength(0);
  });

  it("execute_query reports Basin's error with hints as a tool error, not an RPC error", async () => {
    const h = harness();
    const res = await h.rpc("k-read", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_query", arguments: { sql: "SELECT countIf(1) FROM logs.events" } },
    });
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("count(*) FILTER");
  });

  it("create_log goes through the ingest path: queue and Basin, caller's source, calling key", async () => {
    const h = harness();
    const res = await h.rpc("k-ingest", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "create_log", arguments: { level: "Warning", message: "hi there", source: "my-agent", properties: { Task: "x" } } },
    });
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(h.sent.queue).toHaveLength(1);
    expect(h.sent.queue[0].source).toBe("my-agent");
    expect(h.sent.logs).toHaveLength(1);
    expect(h.sent.logs[0]).toMatchObject({ source: "my-agent", key_id: "id-k-ingest", level: "Warning", message: "hi there", properties: { Task: "x" } });
  });

  it("create_log with QUEUE_WRITE=false: Basin only", async () => {
    const h = harness({ QUEUE_WRITE: "false" });
    const res = await h.rpc("k-ingest", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "create_log", arguments: { level: "Information", message: "basin only", source: "my-agent" } },
    });
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(h.sent.queue).toHaveLength(0);
    expect(h.sent.logs).toEqual([expect.objectContaining({ source: "my-agent", key_id: "id-k-ingest", message: "basin only" })]);
  });

  it("escapes properties named like CLEF fields, so they stay data", async () => {
    const h = harness();
    await h.rpc("k-ingest", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create_log", arguments: { level: "Information", message: "m", source: "s", properties: { "@x": "not an exception", "@tr": "kept" } } },
    });
    expect(h.sent.logs[0]).toMatchObject({ exception: "", properties: { "@@x": "not an exception", "@tr": "kept" } });
  });

  it("won't write to an empty source or the Worker's telemetry source", async () => {
    const h = harness();
    for (const source of ["  ", "log-cannon-ingest"]) {
      const res = await h.rpc("k-ingest", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_log", arguments: { level: "Error", message: "m", source } } });
      expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(true);
    }
    expect(h.sent.queue).toHaveLength(0);
  });

  it("doesn't run a tools/call sent as a notification", async () => {
    const h = harness();
    const res = await h.rpc("k-read", { jsonrpc: "2.0", method: "tools/call", params: { name: "execute_query", arguments: { sql: "SELECT 1" } } });
    expect(res.status).toBe(202);
    expect(h.sent.basin).toHaveLength(0);
  });

  it("refuses a batch over the cap before running any of it", async () => {
    const h = harness();
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } };
    const res = await h.rpc("k-read", Array.from({ length: 11 }, (_, i) => ({ ...call, id: i })));
    expect(res.status).toBe(400);
    expect(h.sent.basin).toHaveLength(0);
  });

  it("rejects bad arguments as invalid params", async () => {
    const h = harness();
    const res = await h.rpc("k-ingest", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_log", arguments: { level: "Loud", message: "m", source: "s" } } });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
    expect(h.sent.queue).toHaveLength(0);
  });
});
