// The Supabase pull (refs #164): ports of supabase-pull's Go tests, plus the
// Worker's own guarantees (cursor held on a failed send or a 429, lease skip,
// seen pruning, the edge-row trim). The Management API is a fake behind a
// mocked fetch that honours the endpoint's semantics: the iso window is
// second-granular and inclusive, the SQL keyset is exact.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "../src/alerts/store";
import type { LogStream } from "../src/basin";
import { assertRowValid, type LogRow } from "../src/parse/row";
import {
  AuthError,
  BackendError,
  RateLimitedError,
  buildSQL,
  parseResponse,
  parseTimestamp,
  queryLogs,
  sqlTimestamp,
  type ApiClient,
  type Row,
} from "../src/supabase/api";
import { keepEdgeProperty, mapLevel, propertyName, toRow } from "../src/supabase/event";
import { DEFAULT_LIMITS, parseProjects, runSupabasePull, summaryLine, type PullDeps, type PullLimits, type SupabasePullEnv } from "../src/supabase/pull";

const REF = "abcdefghijklmnopqrst";
const SOURCE = "example-supabase";
const project = { ref: REF, source: SOURCE };
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0) * 1000; // µs
const S = 1e6;
const MIN = 60 * S;
const HOUR = 60 * MIN;

// --- the fake endpoint -------------------------------------------------------

type Reply = { status: number; body?: string; headers?: Record<string, string> } | "throw";

class FakeSupabase {
  rows = new Map<string, Row[]>();
  calls = 0;
  windows: number[] = [];
  tables: string[] = [];
  /** Replies served before the real ones, in order. */
  queued: Reply[] = [];
  /** Per-table replies, served before that table's real ones. */
  perTable = new Map<string, Reply[]>();
  token = "sbp_test";

  add(table: string, ...rows: Row[]) {
    const list = [...(this.rows.get(table) ?? []), ...rows];
    list.sort((a, b) => a.tsUs - b.tsUs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.rows.set(table, list);
  }

  fetch: typeof fetch = async (input, init) => {
    this.calls++;
    const url = new URL(String(input));
    const q = url.searchParams;
    const sql = q.get("sql")!;
    const table = /source = '([^']+)'/.exec(sql)![1];
    this.tables.push(table);
    const canned = this.queued.shift() ?? this.perTable.get(table)?.shift();
    if (canned === "throw") throw new TypeError("network down");
    if (canned) return new Response(canned.body ?? "", { status: canned.status, headers: canned.headers });
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${this.token}`) return new Response("", { status: 401 });
    if (!url.pathname.startsWith(`/v1/projects/${REF}/analytics/endpoints/logs`)) return new Response("bad path", { status: 404 });

    const lo = parseTimestamp(q.get("iso_timestamp_start"));
    const hi = parseTimestamp(q.get("iso_timestamp_end"));
    this.windows.push(hi - lo);
    const limit = Number(/LIMIT (\d+)$/.exec(sql)![1]);
    const keyset = /\(timestamp > toDateTime64\('([^']+)', 6, 'UTC'\) OR .* AND id > '((?:[^'\\]|\\.)*)'\)\)/.exec(sql);
    const first = /timestamp >= toDateTime64\('([^']+)', 6, 'UTC'\)/.exec(sql);
    const curTs = parseTimestamp((keyset ?? first)![1]);
    const curId = keyset ? keyset[2] : "";
    const out = [];
    for (const r of this.rows.get(table) ?? []) {
      if (r.tsUs < lo || r.tsUs > hi) continue;
      if (curId ? !(r.tsUs > curTs || (r.tsUs === curTs && r.id > curId)) : r.tsUs < curTs) continue;
      out.push({ id: r.id, timestamp: sqlTimestamp(r.tsUs), event_message: r.message, severity_text: r.severity, log_attributes: r.attributes });
      if (out.length === limit) break;
    }
    return Response.json({ result: out, error: null });
  };
}

class FakeStream implements LogStream {
  sent: LogRow[] = [];
  failNext = 0;
  async send(records: LogRow[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("stream unavailable");
    }
    for (const r of records) assertRowValid(r);
    this.sent.push(...records);
  }
  countById() {
    const m = new Map<string, number>();
    for (const r of this.sent) m.set(r.id, (m.get(r.id) ?? 0) + 1);
    return m;
  }
}

function rowsEvery(prefix: string, startUs: number, stepUs: number, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(5, "0")}`,
    tsUs: startUs + i * stepUs,
    message: `${prefix} event ${i}`,
    severity: "info",
    attributes: {},
  }));
}

function expectEachIdOnce(stream: FakeStream, want: number) {
  const counts = stream.countById();
  expect(counts.size).toBe(want);
  for (const [id, c] of counts) expect(c, `id ${id}`).toBe(1);
}

interface Harness {
  api: FakeSupabase;
  stream: FakeStream;
  lines: string[];
  pullEnv: SupabasePullEnv;
  run: (nowUs: number, limits?: Partial<PullLimits>) => ReturnType<typeof runSupabasePull>;
}

function harness(tables = "auth_logs"): Harness {
  const api = new FakeSupabase();
  const stream = new FakeStream();
  const lines: string[] = [];
  const pullEnv: SupabasePullEnv = {
    KEYS_DB: env.KEYS_DB,
    LOGS: stream,
    BASIN_WRITE: "true",
    SUPABASE_PULL_PROJECTS: `${REF}=${SOURCE}`,
    SUPABASE_PULL_TABLES: tables,
    SUPABASE_ACCESS_TOKEN: "sbp_test",
  };
  const run = (nowUs: number, limits?: Partial<PullLimits>) => {
    const deps: PullDeps = {
      now: () => new Date(nowUs / 1000),
      fetch: api.fetch,
      sleep: async () => {},
      emit: async (l) => void lines.push(...l),
      limits,
      apiUrl: "https://api.example.test",
    };
    return runSupabasePull(pullEnv, deps);
  };
  return { api, stream, lines, pullEnv, run };
}

async function cursorOf(table: string) {
  return env.KEYS_DB.prepare("SELECT cursor_ts, cursor_id, read_to FROM supabase_pull_cursor WHERE ref = ? AND log_table = ?")
    .bind(REF, table)
    .first<{ cursor_ts: number; cursor_id: string; read_to: number }>();
}

beforeEach(async () => {
  for (const t of ["supabase_pull_cursor", "supabase_pull_seen", "cron_leases"]) {
    await env.KEYS_DB.prepare(`DELETE FROM ${t}`).run();
  }
});

// --- mapping (event_test.go) -------------------------------------------------

describe("toRow", () => {
  it("keeps the poller's property names and the fixed keys win", () => {
    const r: Row = {
      id: "0d3c-uuid",
      tsUs: Date.UTC(2026, 8, 28, 17, 55, 0) * 1000 + 6123,
      message: "hello",
      severity: "ERROR",
      attributes: {
        "request.path": "/auth/v1/token",
        "parsed.error_severity": "LOG",
        "metadata-host": "db-x",
        empty: "",
        nil: null,
        id: "attribute-id-must-not-win",
        "parsed.session_line_num": 169342,
        ".leading.and.trailing.": "trimmed",
        Source: "attribute-must-not-win",
      },
    };
    const at = new Date("2026-10-23T12:00:00Z");
    const row = toRow(project, "postgres_logs", r, at);
    expect(row.properties).toEqual({
      Source: SOURCE,
      LogTable: "postgres_logs",
      ProjectRef: REF,
      sb_id: "0d3c-uuid",
      sb_request_path: "/auth/v1/token",
      sb_parsed_error_severity: "LOG",
      sb_metadata_host: "db-x",
      sb_parsed_session_line_num: 169342,
      sb_leading_and_trailing: "trimmed",
      sb_Source: "attribute-must-not-win",
    });
    expect(row).toMatchObject({
      id: "0d3c-uuid",
      ts: "2026-09-28T17:55:00.006Z",
      received_at: at.toISOString(),
      source: SOURCE,
      key_id: "supabase-pull",
      format: "supabase",
      kind: "log",
      level: "Error",
      message: "hello",
      // MurmurHash3 x86_32("hello", seed 0), what the Go service gave.
      event_type: "0x248bfa47",
    });
    assertRowValid(row);
  });

  it("maps levels", () => {
    const cases: Record<string, string> = {
      PANIC: "Fatal", fatal: "Fatal", error: "Error", WARNING: "Warning",
      log: "Information", notice: "Information", debug: "Debug", trace: "Verbose",
      "": "Information", "something-new": "Information", constructor: "Information",
    };
    for (const [input, want] of Object.entries(cases)) expect(mapLevel(input), input).toBe(want);
  });

  it("flattens property names", () => {
    expect(propertyName("request.headers.user-agent")).toBe("sb_request_headers_user_agent");
    expect(propertyName("..x..")).toBe("sb_x");
  });
});

// A function_edge_logs row in the shape the endpoint returns, with every value
// replaced by a generic one of realistic length. Real rows measured
// 2,075–2,647 bytes of properties before the trim.
const EDGE_ATTRIBUTES: Record<string, unknown> = {
  "deployment_id": `${REF}_00000000-1111-2222-3333-444444444444_27`,
  "deno_origin": "https://edge-runtime.supabase.com",
  "execution_id": "11111111-2222-3333-4444-555555555555",
  "execution_time_ms": "69",
  "function_id": "00000000-1111-2222-3333-444444444444",
  "identifier": REF,
  "project": REF,
  "project_ref": REF,
  "version": "27",
  "request.id": "9a1b2c3d4e5f6a7b-IAD",
  "request.host": `${REF}.supabase.co`,
  "request.method": "POST",
  "request.pathname": "/functions/v1/example-function",
  "request.protocol": "https:",
  "request.url": `https://${REF}.supabase.co/functions/v1/example-function?page=2&sort=desc`,
  "request.cf.asOrganization": "Example Network Services LLC",
  "request.cf.botManagement.ja3Hash": "0123456789abcdef0123456789abcdef",
  "request.cf.botManagement.ja4": "t13d1516h2_8daaf6152771_02713d6af862",
  "request.cf.city": "Exampleville",
  "request.cf.clientTrustScore": 99,
  "request.cf.colo": "IAD",
  "request.cf.country": "US",
  "request.cf.httpProtocol": "HTTP/2",
  "request.cf.postalCode": "00000",
  "request.cf.region": "Virginia",
  "request.cf.timezone": "America/New_York",
  "request.headers.accept": "*/*",
  "request.headers.accept_encoding": "gzip, deflate, br",
  "request.headers.cf_connecting_ip": "203.0.113.10",
  "request.headers.cf_ipcountry": "US",
  "request.headers.connection": "Keep-Alive",
  "request.headers.content_length": "1234",
  "request.headers.host": `${REF}.supabase.co`,
  "request.headers.user_agent": "Deno/2.1.4 (variant; SupabaseEdgeRuntime/1.67.4)",
  "request.headers.x_forwarded_for": "203.0.113.10",
  "request.headers.x_forwarded_proto": "https",
  "request.headers.x_real_ip": "203.0.113.10",
  "request.sb.jwt.authorization.payload.algorithm": "HS256",
  "request.sb.jwt.authorization.payload.expires_at": "2085000000",
  "request.sb.jwt.authorization.payload.issued_at": "1770000000",
  "request.sb.jwt.authorization.payload.issuer": "supabase",
  "request.sb.jwt.authorization.payload.role": "service_role",
  "request.sb.jwt.authorization.payload.signature_prefix": "AbCdEf",
  "response.headers.content_length": "512",
  "response.headers.content_type": "application/json",
  "response.headers.date": "Fri, 23 Oct 2026 02:30:16 GMT",
  "response.headers.server": "cloudflare",
  "response.headers.vary": "Accept-Encoding",
  "response.headers.x_sb_edge_region": "us-east-1",
  "response.headers.x_served_by": "supabase-edge-runtime",
  "response.headers.x_envoy_upstream_service_time": "70",
  "response.status_code": "200",
};

describe("edge-row trim", () => {
  const edge: Row = { id: "77c05082-297e-4235-afb3-13cc3765fad9", tsUs: T0, message: "POST | 200 | /functions/v1/example-function", severity: "", attributes: EDGE_ATTRIBUTES };

  it("brings a recorded function_edge_logs row under 2,000 bytes and keeps what queries use", () => {
    const untrimmed = toRow(project, "auth_logs", edge, new Date());
    expect(new TextEncoder().encode(JSON.stringify(untrimmed.properties)).length).toBeGreaterThan(2000);

    const row = toRow(project, "function_edge_logs", edge, new Date());
    const bytes = new TextEncoder().encode(JSON.stringify(row.properties)).length;
    expect(bytes).toBeLessThan(2000);
    expect(row.properties).toMatchObject({
      sb_request_method: "POST",
      sb_request_pathname: "/functions/v1/example-function",
      sb_response_status_code: "200",
      sb_function_id: "00000000-1111-2222-3333-444444444444",
      sb_execution_id: "11111111-2222-3333-4444-555555555555",
      sb_execution_time_ms: "69",
      sb_response_headers_x_envoy_upstream_service_time: "70",
      sb_request_headers_user_agent: expect.any(String),
      Source: SOURCE,
      LogTable: "function_edge_logs",
    });
    const json = JSON.stringify(row.properties);
    expect(json).not.toContain("203.0.113.10");
    expect(Object.keys(row.properties).filter((k) => k.startsWith("sb_request_cf_"))).toEqual([]);
  });

  it("drops a connecting IP wherever it sits, even beside a kept header", () => {
    for (const k of ["sb_client_ip", "sb_request_x_forwarded_for", "sb_metadata_x_real_ip", "sb_request_cf_connecting_ip"]) {
      expect(keepEdgeProperty(k), k).toBe(false);
    }
    expect(keepEdgeProperty("sb_request_headers_user_agent")).toBe(true);
    expect(keepEdgeProperty("sb_request_pathname")).toBe(true);
    expect(keepEdgeProperty("sb_response_headers_date")).toBe(false);
  });

  it("leaves the other tables' properties alone", () => {
    const row = toRow(project, "auth_logs", { ...edge, attributes: { "request.headers.x_real_ip": "203.0.113.10" } }, new Date());
    expect(row.properties.sb_request_headers_x_real_ip).toBe("203.0.113.10");
  });
});

// --- the API (supabase_test.go) ----------------------------------------------

describe("buildSQL and parseResponse", () => {
  const ts = Date.UTC(2026, 8, 28, 17, 55, 0) * 1000 + 6123;

  it("builds the keyset", () => {
    expect(buildSQL("auth_logs", { tsUs: ts, id: "" }, 500)).toContain(
      "timestamp >= toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC')",
    );
    const next = buildSQL("auth_logs", { tsUs: ts, id: "o'id" }, 500);
    for (const frag of [
      "source = 'auth_logs'",
      "(timestamp > toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC') OR (timestamp = toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC') AND id > 'o\\'id'))",
      "ORDER BY timestamp ASC, id ASC LIMIT 500",
    ]) {
      expect(next).toContain(frag);
    }
  });

  it("reads every timestamp format to the microsecond", () => {
    const rows = parseResponse(`{"result":[
      {"id":"a","timestamp":"2026-09-28 17:55:00.006123","event_message":"m1","severity_text":"LOG","log_attributes":{"k":"v"}},
      {"id":"b","timestamp":"2026-09-28T17:55:00.006123Z","event_message":"m2"},
      {"id":"c","timestamp":1790618100006123,"event_message":"m3"},
      {"id":"d","timestamp":"2026-09-28T19:55:00.006123+02:00"},
      {"id":"e","timestamp":"2026-09-28T17:55:00.006123999"}
    ]}`);
    for (const r of [rows[0], rows[1], rows[3], rows[4]]) expect(r.tsUs, r.id).toBe(ts);
    expect(rows[2].tsUs).toBe(1790618100006123);
    expect(rows[0]).toMatchObject({ severity: "LOG", attributes: { k: "v" } });
    expect(rows[1].attributes).toEqual({});
  });

  it("surfaces API errors and fails a page with an unplaceable row", () => {
    expect(() => parseResponse(`{"result":[],"error":{"message":"bad sql"}}`)).toThrow(/bad sql/);
    expect(() => parseResponse(`{"result":[],"error":"Backend error! Retry your query."}`)).toThrow(BackendError);
    expect(() => parseResponse(`{"result":[{"id":"x","timestamp":"yesterday"}]}`)).toThrow(/row x/);
    expect(() => parseResponse(`{"result":[{"timestamp":"2026-09-28 17:55:00"}]}`)).toThrow(/no id/);
  });
});

describe("parseProjects", () => {
  it("reads ref=source lists and rejects bad entries", () => {
    expect(parseProjects(" ref1=one-supabase , ref2=two-supabase,")).toEqual([
      { ref: "ref1", source: "one-supabase" },
      { ref: "ref2", source: "two-supabase" },
    ]);
    expect(parseProjects("")).toEqual([]);
    expect(parseProjects(undefined)).toEqual([]);
    for (const bad of ["noequals", "ref=", "=src", "r=a,r=b"]) expect(() => parseProjects(bad), bad).toThrow();
  });
});

describe("queryLogs retries", () => {
  function client(api: FakeSupabase, waits: number[] = []): ApiClient {
    return { baseUrl: "https://api.example.test", token: "sbp_test", fetch: api.fetch, sleep: async (ms) => void waits.push(ms) };
  }
  const q = (c: ApiClient) => queryLogs(c, REF, "auth_logs", { tsUs: T0, id: "" }, T0, T0 + MIN, 500);

  it("ends on a 429 without sleeping", async () => {
    const api = new FakeSupabase();
    api.queued.push({ status: 429, headers: { "Retry-After": "21" }, body: "ThrottlerException: Too Many Requests" });
    const waits: number[] = [];
    await expect(q(client(api, waits))).rejects.toThrow(RateLimitedError);
    expect(api.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("retries a 5xx once, then reports it", async () => {
    const api = new FakeSupabase();
    api.queued.push({ status: 502 }, { status: 502 });
    const waits: number[] = [];
    await expect(q(client(api, waits))).rejects.toThrow(/HTTP 502/);
    expect(api.calls).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it("recovers from one transient failure of each kind", async () => {
    for (const reply of [{ status: 504 }, "throw" as const, { status: 200, body: `{"result":[],"error":"Backend error! Retry your query. Please contact support if this continues."}` }]) {
      const api = new FakeSupabase();
      api.add("auth_logs", ...rowsEvery("a", T0, S, 1));
      api.queued.push(reply);
      expect(await q(client(api))).toHaveLength(1);
      expect(api.calls).toBe(2);
    }
  });

  it("does not retry client errors, and marks a refused token", async () => {
    for (const status of [400, 401, 403]) {
      const api = new FakeSupabase();
      api.queued.push({ status });
      const err = await q({ ...client(api), sleep: async () => expect.fail("slept on a client error") }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err instanceof AuthError, String(status)).toBe(status !== 400);
      expect(api.calls).toBe(1);
    }
  });
});

// --- the run (pull_test.go) --------------------------------------------------

describe("runSupabasePull", () => {
  it("pages through equal timestamps across page boundaries", async () => {
    const h = harness();
    const rows = rowsEvery("a", T0 - 10 * MIN, 100_000, 1203).map((r) => ({ ...r, tsUs: Math.floor(r.tsUs / S) * S }));
    h.api.add("auth_logs", ...rows);

    const { results } = await h.run(T0, { maxLookbackMs: 15 * 60_000 });

    expect(results[0].error).toBeUndefined();
    expect(results[0]).toMatchObject({ pages: 3, inserted: 1203 });
    expectEachIdOnce(h.stream, 1203);
  });

  it("restarts after a stop with no gap and no duplicates", async () => {
    const h = harness();
    h.api.add("auth_logs", ...rowsEvery("before", T0 - HOUR, 7 * S, 500));
    await h.run(T0);

    // Stopped for 30 minutes; Supabase kept logging, and a row that landed
    // late (stamped inside the overlap) arrived too.
    h.api.add("auth_logs", ...rowsEvery("during", T0 + S, 3 * S, 600));
    h.api.add("auth_logs", { id: "late", tsUs: T0 - 2 * MIN, message: "late arrival", severity: "", attributes: {} });

    const { results } = await h.run(T0 + 31 * MIN);

    expect(results[0].error).toBeUndefined();
    expect(results[0].inserted).toBe(601);
    expectEachIdOnce(h.stream, 500 + 600 + 1);
  });

  it("walks a catch-up in windows under the API cap", async () => {
    const h = harness();
    const wm = T0 - 50 * HOUR;
    await env.KEYS_DB.prepare("INSERT INTO supabase_pull_cursor VALUES (?, 'auth_logs', ?, 'old', ?, '')").bind(REF, wm, wm).run();
    h.api.add("auth_logs", ...rowsEvery("gap", wm + MIN, 10 * MIN, 300));

    const { results } = await h.run(T0);

    expect(results[0].error).toBeUndefined();
    expect(results[0].inserted).toBe(300);
    for (const w of h.api.windows) expect(w).toBeLessThanOrEqual(24 * HOUR);
  });

  it("starts an empty table at the lookback floor", async () => {
    const h = harness();
    h.api.add("auth_logs", { id: "too-old", tsUs: T0 - 31 * HOUR, message: "x", severity: "", attributes: {} });
    h.api.add("auth_logs", { id: "in-range", tsUs: T0 - 29 * HOUR, message: "y", severity: "", attributes: {} });

    const { results } = await h.run(T0, { maxLookbackMs: 30 * 3600_000 });

    expect(results[0].inserted).toBe(1);
    expect(h.stream.sent.map((r) => r.id)).toEqual(["in-range"]);
  });

  it("stops at the page cap and the next run continues", async () => {
    const h = harness();
    h.api.add("auth_logs", ...rowsEvery("b", T0 - HOUR, S, 1400));
    const limits = { maxPages: 2, maxLookbackMs: 2 * 3600_000 };

    const first = await h.run(T0, limits);
    expect(first.results[0]).toMatchObject({ behind: true, inserted: 1000 });
    const second = await h.run(T0, limits);
    expect(second.results[0].behind).toBeUndefined();
    expect(second.results[0].inserted).toBe(400);
    expectEachIdOnce(h.stream, 1400);
  });

  it("reports a refused token and sends nothing", async () => {
    const h = harness();
    h.pullEnv.SUPABASE_ACCESS_TOKEN = "wrong";
    h.api.add("auth_logs", ...rowsEvery("a", T0 - MIN, S, 5));

    const { results } = await h.run(T0);

    expect(results[0].authFailed).toBe(true);
    expect(results[0].error).toMatch(/access token/);
    expect(h.stream.sent).toEqual([]);
    expect(JSON.parse(h.lines[0])).toMatchObject({
      "@l": "Error",
      "@mt": "supabase-pull: Supabase rejected the access token; {Failed} of {TableCount} tables failed",
      AuthFailed: true,
      Failed: 1,
    });
  });

  it("does not re-walk a quiet table's lookback every run", async () => {
    const h = harness();
    await h.run(T0);
    const firstCalls = h.api.calls;
    h.api.windows = [];
    await h.run(T0 + MIN);

    expect(firstCalls).toBeGreaterThanOrEqual(4); // 72h in 23h windows
    expect(h.api.calls - firstCalls).toBe(1);
    expect(h.api.windows[0]).toBeLessThanOrEqual(10 * MIN);
  });

  it("reaches the present when the lookback is longer than the page cap", async () => {
    const h = harness();
    h.api.add("auth_logs", { id: "recent", tsUs: T0 - HOUR, message: "x", severity: "", attributes: {} });
    const limits = { maxLookbackMs: 60 * 24 * 3600_000, maxPages: 20 };
    for (let run = 1; run <= 5; run++) {
      const { results } = await h.run(T0, limits);
      if (!results[0].behind) {
        expect(results[0].inserted).toBe(1);
        return;
      }
    }
    expect.fail("still behind after 5 runs; each run is restarting from the floor");
  });

  it("reports read lag as the health signal, not watermark age", async () => {
    const h = harness("auth_logs,function_logs");
    h.api.add("auth_logs", { id: "a", tsUs: T0 - 2 * HOUR, message: "x", severity: "", attributes: {} });

    const { results } = await h.run(T0);

    for (const r of results) expect(r.read_lag_s, r.table).toBe(0);
    expect(results[0].watermark_age_s).toBe(7200);
    expect(results[1].watermark_age_s).toBeUndefined();
  });

  it("counts a table that failed before reading as the whole lookback behind", async () => {
    const h = harness();
    h.api.queued.push({ status: 400, body: "boom" });
    const { results } = await h.run(T0);
    expect(results[0].read_lag_s).toBe(DEFAULT_LIMITS.maxLookbackMs / 1000);
  });

  // --- new for the Worker ---

  it("leaves the cursor where it was when a send fails, and re-sends next tick", async () => {
    const h = harness();
    h.api.add("auth_logs", ...rowsEvery("a", T0 - 10 * MIN, S, 50));
    await h.run(T0);
    const before = await cursorOf("auth_logs");

    h.api.add("auth_logs", ...rowsEvery("b", T0 + S, S, 30));
    h.stream.failNext = 1;
    const failed = await h.run(T0 + MIN);
    expect(failed.results[0].error).toMatch(/^send 30 rows: stream unavailable/);
    expect(await cursorOf("auth_logs")).toEqual(before);
    expect(JSON.parse(h.lines.at(-1)!)).toMatchObject({ "@l": "Error", Failed: 1 });

    const retried = await h.run(T0 + 2 * MIN);
    expect(retried.results[0]).toMatchObject({ inserted: 30 });
    expectEachIdOnce(h.stream, 80);
  });

  it("ends a table on a 429 without moving its cursor, and the other tables still run", async () => {
    const h = harness("auth_logs,function_logs");
    h.api.add("auth_logs", ...rowsEvery("a", T0 - MIN, S, 5));
    h.api.add("function_logs", ...rowsEvery("f", T0 - MIN, S, 5));
    h.api.perTable.set("auth_logs", [{ status: 429, headers: { "Retry-After": "21" } }]);

    const { results } = await h.run(T0);

    expect(results[0]).toMatchObject({ table: "auth_logs", rate_limited: true, behind: true, inserted: 0 });
    expect(results[0].error).toBeUndefined();
    expect(await cursorOf("auth_logs")).toBeNull();
    expect(results[1]).toMatchObject({ table: "function_logs", inserted: 5 });
    expect(h.api.tables.filter((t) => t === "auth_logs")).toHaveLength(1);
    const summary = JSON.parse(h.lines[0]);
    expect(summary).toMatchObject({ "@l": "Information", RateLimited: 1, Behind: true, Failed: 0 });

    const next = await h.run(T0 + MIN);
    expect(next.results[0].inserted).toBe(5);
  });

  it("skips the tick while another run holds the lease", async () => {
    const h = harness();
    h.api.add("auth_logs", ...rowsEvery("a", T0 - MIN, S, 5));
    expect(await acquireLease(env.KEYS_DB, "supabase-pull", "other", T0 / 1000, 60_000)).toBe(true);

    expect(await h.run(T0)).toEqual({ skipped: "lease-held", results: [] });
    expect(h.api.calls).toBe(0);

    // Once it expires the next tick runs, and releases it after.
    expect((await h.run(T0 + 2 * MIN)).results[0].inserted).toBe(5);
    expect(await env.KEYS_DB.prepare("SELECT * FROM cron_leases WHERE name = 'supabase-pull'").first()).toBeNull();
  });

  it("prunes seen ids older than the overlap behind the table's position", async () => {
    const h = harness();
    h.api.add("auth_logs", ...rowsEvery("a", T0 - 20 * MIN, MIN, 20));
    await h.run(T0);
    const seen = async () =>
      (await env.KEYS_DB.prepare("SELECT sb_id, ts FROM supabase_pull_seen ORDER BY ts").all<{ sb_id: string; ts: number }>()).results;

    // Read to T0, so only ids inside the 5 minutes behind it are kept.
    let ids = await seen();
    expect(ids.length).toBeGreaterThan(0);
    for (const r of ids) expect(r.ts).toBeGreaterThanOrEqual(T0 - 5 * MIN);
    expect(ids.map((r) => r.sb_id)).toEqual(["a-00015", "a-00016", "a-00017", "a-00018", "a-00019"]);

    await h.run(T0 + 30 * MIN);
    ids = await seen();
    expect(ids).toEqual([]);
  });

  it("is a no-op with no projects, with Basin writes off, or with a bad config", async () => {
    for (const [patch, skipped] of [
      [{ SUPABASE_PULL_PROJECTS: "" }, "off"],
      [{ BASIN_WRITE: "false" }, "basin-off"],
      [{ LOGS: undefined }, "basin-off"],
      [{ SUPABASE_ACCESS_TOKEN: "" }, "config"],
      [{ SUPABASE_PULL_PROJECTS: "no-equals" }, "config"],
    ] as const) {
      const h = harness();
      Object.assign(h.pullEnv, patch);
      expect((await h.run(T0)).skipped).toBe(skipped);
      expect(h.api.calls).toBe(0);
      expect(h.lines.length).toBe(skipped === "config" ? 1 : 0);
    }
  });

  it("defaults to all four tables and writes one summary per run", async () => {
    const h = harness("");
    const { results } = await h.run(T0);
    expect(results.map((r) => r.table)).toEqual(["postgres_logs", "auth_logs", "function_logs", "function_edge_logs"]);
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0])).toMatchObject({
      "@l": "Information",
      "@mt": "supabase-pull inserted {Inserted} rows in {Pages} pages; read lag {MaxReadLagSeconds}s",
      TableCount: 4,
      Failed: 0,
      Behind: false,
      MaxReadLagSeconds: 0,
      Tables: [],
    });
  });
});

describe("summaryLine", () => {
  it("lists only problem tables, and stays small when every table is healthy", () => {
    const ok = Array.from({ length: 32 }, (_, i) => ({ project: `p${i}`, table: "auth_logs", fetched: 1, inserted: 1, skipped: 0, pages: 1, read_lag_s: 0.5 }));
    expect(summaryLine(ok, new Date(T0 / 1000), 10).length).toBeLessThan(2000);
    const bad = [...ok, { ...ok[0], error: "page 1: boom" }];
    expect(JSON.parse(summaryLine(bad, new Date(T0 / 1000), 10))).toMatchObject({
      "@l": "Error",
      "@mt": "supabase-pull: {Failed} of {TableCount} tables failed; inserted {Inserted} rows",
      Tables: [{ error: "page 1: boom" }],
    });
  });
});
