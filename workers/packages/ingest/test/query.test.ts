import { afterEach, describe, expect, it, vi } from "vitest";
import { BasinQueryError, JSON_ARG_LIMIT, MAX_BASIN_RESPONSE_BYTES, propNumber, propString, queryBasin, sqlString } from "../src/basin-sql";
import {
  MAX_QUERY_ROWS,
  QueryRejected,
  buildSearchSql,
  dialectHints,
  parseOperatorFromValue,
  prepareQuery,
  searchParamsFromUrl,
  toLogOut,
} from "../src/query";

const ENV = { BASIN_SQL_TOKEN: "t", BASIN_SQL_ACCOUNT: "acct", BASIN_SQL_BUCKET: "bucket" };

describe("prepareQuery", () => {
  it("adds the row cap only when there is no LIMIT", () => {
    expect(prepareQuery("SELECT 1 FROM logs.events")).toBe(`SELECT 1 FROM logs.events\nLIMIT ${MAX_QUERY_ROWS}`);
    expect(prepareQuery("select 1 from logs.events limit 5")).toBe("select 1 from logs.events limit 5");
  });

  it("strips a trailing semicolon before appending the cap", () => {
    expect(prepareQuery("SELECT 1 FROM logs.events; ")).toBe(`SELECT 1 FROM logs.events\nLIMIT ${MAX_QUERY_ROWS}`);
  });

  it("keeps the cap out of a trailing line comment", () => {
    expect(prepareQuery("SELECT 1 FROM logs.events -- note").split("\n").at(-1)).toBe(`LIMIT ${MAX_QUERY_ROWS}`);
  });

  it("accepts WITH and rejects anything that isn't a read", () => {
    expect(prepareQuery("WITH x AS (SELECT 1) SELECT * FROM x LIMIT 1")).toMatch(/^WITH/);
    for (const bad of ["DELETE FROM logs.events", "", "  ", "selectx FROM t", 42]) {
      expect(() => prepareQuery(bad)).toThrow(QueryRejected);
    }
  });
});

describe("dialectHints", () => {
  it("names the DataFusion spelling for each ClickHouse-ism present", () => {
    const hints = dialectHints(
      "SELECT countIf(level = 'Error'), uniqExact(source), toStartOfHour(timestamp), JSONExtractString(properties, 'k') FROM logs.events WHERE timestamp > now() - INTERVAL 1 HOUR",
    );
    expect(hints.join("\n")).toContain("count(*) FILTER");
    expect(hints.join("\n")).toContain("count(DISTINCT x)");
    expect(hints.join("\n")).toContain("date_trunc");
    expect(hints.join("\n")).toContain("json_get_str");
    expect(hints.join("\n")).toContain("INTERVAL '1 hour'");
    expect(hints.join("\n")).toContain("column is ts");
  });

  it("says nothing about SQL that is already DataFusion", () => {
    expect(dialectHints("SELECT count(*) FILTER (WHERE level = 'Error') FROM logs.events WHERE ts > now() - INTERVAL '1 hour'")).toEqual([]);
  });
});

describe("sqlString and property guards", () => {
  it("doubles single quotes and nothing else", () => {
    expect(sqlString("it's \\ fine")).toBe("'it''s \\ fine'");
  });

  it("guards every json_get on the 2000-byte argument cap", () => {
    for (const sql of [propString(["a"]), propString(["a", "b"]), propNumber(["a"]), propNumber(["a", "b"])]) {
      expect(sql).toMatch(new RegExp(`^CASE WHEN octet_length\\(properties\\) <= ${JSON_ARG_LIMIT} THEN `));
      // No json_get_* in the ELSE branch: that's the branch for oversized rows.
      expect(sql.split(" ELSE ")[1]).not.toMatch(/json_get/);
    }
  });

  it("falls back to a regex over the raw text for top-level keys only", () => {
    expect(propString(["Path"])).toContain(`regexp_match(properties, '"Path":"([^"\\\\]*)"')`);
    expect(propString(["a", "b"]).split(" ELSE ")[1]).toBe("NULL END");
  });

  it("reads a malformed number on a large row as NULL, not a query error", () => {
    expect(propNumber(["Version"]).split(" ELSE ")[1]).toMatch(/^TRY_CAST\(/);
  });

  it("escapes regex and SQL metacharacters in a key", () => {
    const sql = propString(["a.b'(c"].map((k) => k));
    expect(sql).toContain(`'"a\\.b''\\(c":`);
  });
});

describe("buildSearchSql", () => {
  it("defaults to the last 24 hours, newest first, 100 rows", () => {
    const sql = buildSearchSql({});
    expect(sql).toContain("WHERE ts > now() - INTERVAL '24 hours'");
    expect(sql).toMatch(/ORDER BY ts DESC LIMIT 100$/);
  });

  it("clamps hours and limit", () => {
    expect(buildSearchSql({ hours: 99999, limit: 5000 })).toMatch(/INTERVAL '720 hours'.*LIMIT 1000$/);
    expect(buildSearchSql({ hours: 0, limit: 0 })).toMatch(/INTERVAL '1 hours'.*LIMIT 1$/);
  });

  it("matches search text literally, so % and _ aren't wildcards", () => {
    expect(buildSearchSql({ search: "50%_off'" })).toContain("strpos(message, '50%_off''') > 0");
  });

  it("compares numeric property values as numbers and strings as strings", () => {
    const sql = buildSearchSql({
      propertyFilters: [
        { key: "Delta", value: "10", operator: ">" },
        { key: "Env", value: "prod", operator: ">" },
      ],
    });
    expect(sql).toMatch(/json_get_float\(properties, 'Delta'\).* > 10/);
    expect(sql).toMatch(/json_get_str\(properties, 'Env'\).* = 'prod'/);
  });

  it("never splices a non-numeric value unquoted", () => {
    const sql = buildSearchSql({ propertyFilters: [{ key: "x", value: "1 OR 1=1", operator: ">" }] });
    expect(sql).toContain("= '1 OR 1=1'");
  });
});

describe("searchParamsFromUrl", () => {
  it("reads v1's parameters and prop.* operators", () => {
    const p = searchParamsFromUrl(new URL("https://x/v2/api/v1/logs?source=A&level=Error&limit=5&hours=2&trace_id=t&prop.Delta=>%3D3&prop.Env=prod"));
    expect(p).toMatchObject({ source: "A", level: "Error", limit: 5, hours: 2, traceId: "t" });
    expect(p.propertyFilters).toEqual([
      { key: "Delta", operator: ">=", value: "3" },
      { key: "Env", operator: "=", value: "prod" },
    ]);
  });

  it("parses each operator prefix", () => {
    expect(parseOperatorFromValue("!=a")).toEqual({ operator: "!=", value: "a" });
    expect(parseOperatorFromValue("<=1")).toEqual({ operator: "<=", value: "1" });
    expect(parseOperatorFromValue("=a")).toEqual({ operator: "=", value: "=a" });
  });
});

describe("toLogOut", () => {
  it("parses properties and drops empty optional fields", () => {
    expect(
      toLogOut({ id: "1", ts: "t", level: "Information", message: "m", message_template: "", exception: "", kind: "log", trace_id: null, properties: '{"a":1}' }),
    ).toEqual({ id: "1", ts: "t", level: "Information", message: "m", properties: { a: 1 } });
  });
});

describe("queryBasin", () => {
  afterEach(() => vi.restoreAllMocks());

  const reply = (status: number, body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("sends the query with the token and returns rows and bytes scanned", async () => {
    const f = reply(200, { success: true, result: { rows: [{ n: 1 }], metrics: { bytes_scanned: 42 } } });
    await expect(queryBasin(ENV, "SELECT 1")).resolves.toEqual({ rows: [{ n: 1 }], bytesScanned: 42 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sql.cloudflarestorage.com/api/v1/accounts/acct/basin-sql/query/bucket");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer t");
    expect(JSON.parse(init.body as string)).toEqual({ query: "SELECT 1" });
  });

  it("maps Basin's 4xxxx codes to a caller error and the rest to upstream", async () => {
    reply(400, { success: false, errors: [{ code: 40003, message: "invalid SQL" }] });
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 400, message: "invalid SQL" });
    reply(500, { success: false, errors: [{ code: 10001, message: "internal" }] });
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 502 });
    reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 502 });
  });

  it("is a 503, not a crash, when the token isn't set", async () => {
    await expect(queryBasin({}, "x")).rejects.toBeInstanceOf(BasinQueryError);
    await expect(queryBasin({}, "x")).rejects.toMatchObject({ status: 503 });
  });

  it("refuses a response over the byte cap without buffering it", async () => {
    const big = new Uint8Array(MAX_BASIN_RESPONSE_BYTES + 1).fill(32);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob([big]).stream()));
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 413 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { headers: { "Content-Length": String(MAX_BASIN_RESPONSE_BYTES + 1) } }));
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 413 });
  });

  it("treats Basin rate limiting as retryable", async () => {
    reply(429, { success: false, errors: [{ code: 10429, message: "slow down" }] });
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 503 });
  });

  it("reports a timeout as 504", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(queryBasin(ENV, "x")).rejects.toMatchObject({ status: 504 });
  });
});
