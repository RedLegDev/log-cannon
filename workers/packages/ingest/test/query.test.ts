import { afterEach, describe, expect, it, vi } from "vitest";
import { BasinQueryError, JSON_ARG_LIMIT, MAX_BASIN_RESPONSE_BYTES, propNumber, propString, queryBasin, sqlString } from "../src/basin-sql";
import {
  MAX_QUERY_ROWS,
  QueryRejected,
  buildContextSql,
  buildEventLookupSql,
  buildSearchSql,
  buildStatsSql,
  decodeCursor,
  dialectHints,
  encodeCursor,
  eventParamsFromUrl,
  getEvent,
  parseInstant,
  parseOperatorFromValue,
  prepareQuery,
  searchLogs,
  searchParamsFromUrl,
  statsParamsFromUrl,
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
    expect(dialectHints("SELECT count(*) FROM logs.events WHERE ts > TIMESTAMP '2026-10-23T14:00:00Z' - INTERVAL '5 minutes'")).toEqual([]);
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
    expect(sql).toMatch(/ORDER BY ts DESC, id DESC LIMIT 100$/);
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

const NOW = new Date("2026-11-20T12:00:00Z");

describe("search windows: from / to", () => {
  it("pins an absolute window [from, to) and ignores hours", () => {
    const sql = buildSearchSql({ from: "2026-11-17T20:20:00Z", to: "2026-11-17T23:50:00Z", hours: 1 }, NOW);
    expect(sql).toContain("WHERE ts >= TIMESTAMP '2026-11-17T20:20:00.000Z' AND ts < TIMESTAMP '2026-11-17T23:50:00.000Z'");
    expect(sql).not.toContain("now()");
  });

  it("reads epoch milliseconds, as a string or a number", () => {
    const ms = Date.parse("2026-11-17T20:20:00Z");
    expect(buildSearchSql({ from: String(ms) }, NOW)).toContain("ts >= TIMESTAMP '2026-11-17T20:20:00.000Z'");
    expect(parseInstant(ms, "from").toISOString()).toBe("2026-11-17T20:20:00.000Z");
  });

  it("leaves the upper bound open when only from is given, as hours does", () => {
    const sql = buildSearchSql({ from: "2026-11-20T10:00:00Z" }, NOW);
    expect(sql).toContain("WHERE ts >= TIMESTAMP '2026-11-20T10:00:00.000Z' ORDER BY");
    expect(sql).not.toContain("ts <");
  });

  it("counts hours back from to when only to is given", () => {
    expect(buildSearchSql({ to: "2026-11-20T00:00:00Z", hours: 2 }, NOW)).toContain(
      "ts >= TIMESTAMP '2026-11-19T22:00:00.000Z' AND ts < TIMESTAMP '2026-11-20T00:00:00.000Z'",
    );
  });

  it("caps the window at 720 hours, with to defaulting to now", () => {
    expect(() => buildSearchSql({ from: "2026-10-21T12:00:00Z" }, NOW)).not.toThrow();
    expect(() => buildSearchSql({ from: "2026-10-21T11:59:59Z" }, NOW)).toThrow(/over 720 hours/);
    expect(() => buildSearchSql({ from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }, NOW)).toThrow(QueryRejected);
  });

  it("refuses unreadable times and backwards windows instead of ignoring them", () => {
    for (const bad of ["yesterday", "2026-13-45", "-5", "1e12", "99999999999999999"]) {
      expect(() => buildSearchSql({ from: bad }, NOW), bad).toThrow(QueryRejected);
    }
    expect(() => buildSearchSql({ from: "2026-11-20T10:00:00Z", to: "2026-11-20T09:00:00Z" }, NOW)).toThrow(/before to/);
    expect(() => buildSearchSql({ from: "2026-11-21T00:00:00Z" }, NOW)).toThrow(/before to/);
  });
});

describe("search: exception and order", () => {
  it("matches exception text literally with strpos, never a prunable comparison", () => {
    const sql = buildSearchSql({ exception: "Null%_Ref'" });
    expect(sql).toContain("strpos(exception, 'Null%_Ref''') > 0");
    expect(sql).not.toMatch(/exception (=|LIKE|>|<)/);
  });

  it("orders asc on request and rejects anything else", () => {
    expect(buildSearchSql({ order: "asc" })).toMatch(/ORDER BY ts ASC, id ASC LIMIT 100$/);
    expect(() => buildSearchSql({ order: "newest" })).toThrow(QueryRejected);
  });
});

describe("search cursors", () => {
  const c = { order: "desc" as const, ts: "2026-11-17T21:00:00.123456", id: "ev|7'x" };

  it("round-trips order, the exact ts text and an id containing | and quotes", () => {
    const s = encodeCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(c);
  });

  it("continues desc after (ts, id): earlier ts, or the same ts and a smaller id", () => {
    const sql = buildSearchSql({ cursor: encodeCursor(c) });
    expect(sql).toContain(
      "(ts < TIMESTAMP '2026-11-17T21:00:00.123456' OR (ts = TIMESTAMP '2026-11-17T21:00:00.123456' AND id < 'ev|7''x'))",
    );
    expect(sql).toMatch(/ORDER BY ts DESC, id DESC LIMIT/);
  });

  it("continues asc after (ts, id): later ts, or the same ts and a larger id", () => {
    const sql = buildSearchSql({ order: "asc", cursor: encodeCursor({ ...c, order: "asc" }) });
    expect(sql).toContain("(ts > TIMESTAMP '2026-11-17T21:00:00.123456' OR (ts = TIMESTAMP '2026-11-17T21:00:00.123456' AND id > 'ev|7''x'))");
    expect(sql).toMatch(/ORDER BY ts ASC, id ASC LIMIT/);
  });

  it("refuses a cursor from the other order, or one it didn't issue", () => {
    expect(() => buildSearchSql({ order: "asc", cursor: encodeCursor(c) })).toThrow(/order=desc/);
    for (const bad of ["!!!", "Zm9v", encodeCursor({ ...c, ts: "2026-11-17' OR 1=1 --" }), btoa("desc|2026-11-17T21:00:00|")]) {
      expect(() => buildSearchSql({ cursor: bad }), bad).toThrow(QueryRejected);
    }
  });

  it("pages rows that share a timestamp without skipping or repeating any, one Basin query per page", async () => {
    // A fake Basin that applies the generated cursor, order and limit to a
    // fixed table: five rows at one instant between two others.
    const table = [
      { id: "a", cursor_ts: "2026-11-17T21:00:00" },
      { id: "b", cursor_ts: "2026-11-17T21:00:01" },
      { id: "c", cursor_ts: "2026-11-17T21:00:01" },
      { id: "d", cursor_ts: "2026-11-17T21:00:01" },
      { id: "e", cursor_ts: "2026-11-17T21:00:01" },
      { id: "f", cursor_ts: "2026-11-17T21:00:01" },
      { id: "g", cursor_ts: "2026-11-17T21:00:02" },
    ];
    const key = (r: { id: string; cursor_ts: string }) => `${r.cursor_ts}|${r.id}`;
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const sql = JSON.parse(String(init?.body)).query as string;
      const asc = / ORDER BY ts ASC, id ASC /.test(sql);
      const m = sql.match(/\(ts [<>] TIMESTAMP '([^']+)' OR \(ts = TIMESTAMP '[^']+' AND id [<>] '([^']*)'\)\)/);
      const after = m ? `${m[1]}|${m[2]}` : null;
      const limit = Number(sql.match(/LIMIT (\d+)$/)![1]);
      const rows = [...table]
        .sort((x, y) => (asc ? key(x).localeCompare(key(y)) : key(y).localeCompare(key(x))))
        .filter((r) => after === null || (asc ? key(r) > after : key(r) < after))
        .slice(0, limit)
        .map((r) => ({ ...r, ts: r.cursor_ts, level: "Information", message: "m", source: "s" }));
      return new Response(JSON.stringify({ success: true, result: { rows } }));
    });
    try {
      for (const order of ["asc", "desc"]) {
        f.mockClear();
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await searchLogs(ENV, { order, limit: 2, cursor, from: "2026-11-17T20:00:00Z", to: "2026-11-17T22:00:00Z" });
          seen.push(...page.data.map((r) => r.id));
          cursor = page.meta.next_cursor as string | undefined;
          pages++;
        } while (cursor && pages < 10);
        const ids = table.map((r) => r.id);
        expect(seen).toEqual(order === "asc" ? ids : [...ids].reverse());
        expect(f).toHaveBeenCalledTimes(pages);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves next_cursor off a page that isn't full", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { rows: [{ id: "a", ts: "t", cursor_ts: "2026-11-17T21:00:00" }] } })),
    );
    try {
      const page = await searchLogs(ENV, { limit: 2 });
      expect(page.meta).not.toHaveProperty("next_cursor");
      expect(page.data[0]).not.toHaveProperty("cursor_ts");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("buildStatsSql", () => {
  it("shares search's filters and counts rows and distinct ids", () => {
    const sql = buildStatsSql({ source: "api", level: "Error", search: "x", exception: "y", traceId: "t", hours: 6 });
    expect(sql).toBe(
      `SELECT count(*) AS count, count(DISTINCT id) AS "unique" FROM logs.events WHERE ts > now() - INTERVAL '6 hours' ` +
        "AND source = 'api' AND level = 'Error' AND strpos(message, 'x') > 0 AND strpos(exception, 'y') > 0 AND trace_id = 't' " +
        "ORDER BY count DESC LIMIT 100",
    );
  });

  it("groups by columns and buckets by hour, ordered by bucket then count", () => {
    const sql = buildStatsSql({ groupBy: ["level", "source"], bucket: "hour" });
    expect(sql).toContain("SELECT date_trunc('hour', ts) AS bucket, level AS g0, source AS g1, count(*) AS count");
    expect(sql).toContain("GROUP BY date_trunc('hour', ts), level, source ORDER BY bucket ASC, count DESC LIMIT 100");
  });

  it("truncates to each bucket size", () => {
    expect(buildStatsSql({ bucket: "minute" })).toContain("date_trunc('minute', ts) AS bucket");
    expect(buildStatsSql({ bucket: "day" })).toContain("date_trunc('day', ts) AS bucket");
    expect(buildStatsSql({ bucket: "5m" })).toContain("date_bin(INTERVAL '5 minutes', ts, TIMESTAMP '1970-01-01T00:00:00') AS bucket");
    expect(buildStatsSql({ bucket: "15m" })).toContain("date_bin(INTERVAL '15 minutes', ts, TIMESTAMP '1970-01-01T00:00:00') AS bucket");
    expect(() => buildStatsSql({ bucket: "week" })).toThrow(QueryRejected);
  });

  it("groups a property key through the guarded helper, so oversized rows read as null", () => {
    const sql = buildStatsSql({ groupBy: ["prop:Request.Path"] });
    expect(sql).toContain(`${propString(["Request", "Path"])} AS g0`);
    expect(sql).toContain(`GROUP BY ${propString(["Request", "Path"])} ORDER BY`);
    expect(propString(["Request", "Path"])).toMatch(new RegExp(`^CASE WHEN octet_length\\(properties\\) <= ${JSON_ARG_LIMIT} THEN .* ELSE NULL END$`));
  });

  it("caps group_by at two known keys and the limit at 10,000", () => {
    expect(() => buildStatsSql({ groupBy: ["level", "source", "event_type"] })).toThrow(/at most 2/);
    expect(() => buildStatsSql({ groupBy: ["key_id"] })).toThrow(QueryRejected);
    expect(() => buildStatsSql({ groupBy: ["prop:"] })).toThrow(QueryRejected);
    expect(() => buildStatsSql({ groupBy: ["level", "level"] })).toThrow(QueryRejected);
    expect(buildStatsSql({ limit: 50_000 })).toMatch(/LIMIT 10000$/);
  });

  it("applies the same window rules as search", () => {
    expect(buildStatsSql({ from: "2026-11-17T20:00:00Z", to: "2026-11-17T21:00:00Z" }, NOW)).toContain(
      "WHERE ts >= TIMESTAMP '2026-11-17T20:00:00.000Z' AND ts < TIMESTAMP '2026-11-17T21:00:00.000Z'",
    );
    expect(() => buildStatsSql({ from: "2026-01-01T00:00:00Z" }, NOW)).toThrow(/720 hours/);
  });

  it("reads REST params: comma-separated group_by, bucket, filters", () => {
    expect(statsParamsFromUrl(new URL("https://x/api/v1/stats?group_by=level,%20prop:Path&bucket=hour&exception=E&from=1&limit=7"))).toMatchObject({
      groupBy: ["level", "prop:Path"],
      bucket: "hour",
      exception: "E",
      from: "1",
      limit: 7,
    });
  });
});

describe("event lookup", () => {
  it("matches the id with strpos and its length, never = on id, inside the default 24 hours", () => {
    const sql = buildEventLookupSql({ id: "ab'c" }, NOW);
    expect(sql).toContain("WHERE ts > now() - INTERVAL '24 hours' AND strpos(id, 'ab''c') > 0 AND octet_length(id) = 4");
    expect(sql).not.toMatch(/\bid (=|IN|LIKE)/);
  });

  it("narrows to ±10 minutes around ts, or looks back hours (max 720)", () => {
    expect(buildEventLookupSql({ id: "x", ts: "2026-11-17T21:00:00Z" })).toContain(
      "ts >= TIMESTAMP '2026-11-17T20:50:00.000Z' AND ts <= TIMESTAMP '2026-11-17T21:10:00.000Z'",
    );
    expect(buildEventLookupSql({ id: "x", hours: 5000 })).toContain("INTERVAL '720 hours'");
    expect(() => buildEventLookupSql({ id: "x", ts: "soon" })).toThrow(QueryRejected);
    expect(() => buildEventLookupSql({ id: "" })).toThrow(QueryRejected);
  });

  it("builds source and trace context windows around the event's exact ts", () => {
    const ev = { ts: "2026-11-17T21:00:00.5", source: "api", trace_id: "t1" };
    expect(buildContextSql(ev, { id: "x", context: "source" })).toContain(
      "WHERE ts >= TIMESTAMP '2026-11-17T21:00:00.5' - INTERVAL '5 minutes' AND ts <= TIMESTAMP '2026-11-17T21:00:00.5' + INTERVAL '1 minutes' AND source = 'api' ORDER BY ts ASC, id ASC LIMIT 200",
    );
    expect(buildContextSql(ev, { id: "x", context: "trace", beforeMinutes: 30, afterMinutes: 0, limit: 5000 })).toMatch(
      /INTERVAL '30 minutes' .* INTERVAL '0 minutes' AND trace_id = 't1' ORDER BY ts ASC, id ASC LIMIT 1000$/,
    );
    expect(buildContextSql({ ...ev, trace_id: null }, { id: "x", context: "trace" })).toBeNull();
    expect(buildContextSql(ev, { id: "x" })).toBeNull();
    expect(() => buildContextSql(ev, { id: "x", context: "host" })).toThrow(QueryRejected);
  });

  it("returns only an exact id match, and null when none came back", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { rows: [{ id: "xab", ts: "t", cursor_ts: "2026-11-17T21:00:00" }] } })),
    );
    try {
      expect(await getEvent(ENV, { id: "abx" })).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reads REST params", () => {
    expect(eventParamsFromUrl("e1", new URL("https://x/api/v1/events/e1?ts=1700000000000&context=trace&before_minutes=2&after_minutes=3&limit=9"))).toEqual({
      id: "e1",
      ts: "1700000000000",
      hours: undefined,
      context: "trace",
      beforeMinutes: 2,
      afterMinutes: 3,
      limit: 9,
    });
  });
});

describe("several sources", () => {
  it("keeps one source as today's equality", () => {
    expect(buildSearchSql({ source: "A" })).toBe(buildSearchSql({ source: ["A"] }));
    expect(buildSearchSql({ source: ["A"] })).toContain("AND source = 'A' ORDER BY");
  });

  it("matches several with IN, each value escaped, duplicates and blanks dropped", () => {
    const sql = buildSearchSql({ source: ["readerful", "Readerful", "o'neil", "readerful", ""] });
    expect(sql).toContain("source IN ('readerful', 'Readerful', 'o''neil')");
    expect(buildStatsSql({ source: ["a", "b"], groupBy: ["source"] })).toContain("source IN ('a', 'b')");
  });

  it("caps the list at 20", () => {
    const many = Array.from({ length: 21 }, (_, i) => `s${i}`);
    expect(() => buildSearchSql({ source: many.slice(0, 20) })).not.toThrow();
    expect(() => buildSearchSql({ source: many })).toThrow(/at most 20/);
  });

  it("splits a comma-separated REST source", () => {
    expect(searchParamsFromUrl(new URL("https://x/api/v1/logs?source=readerful,%20Readerful")).source).toEqual(["readerful", "Readerful"]);
    expect(statsParamsFromUrl(new URL("https://x/api/v1/stats?source=a,b")).source).toEqual(["a", "b"]);
    expect(searchParamsFromUrl(new URL("https://x/api/v1/logs?source=")).source).toBeUndefined();
  });
});

describe("searchParamsFromUrl", () => {
  it("reads from, to, order, cursor and exception", () => {
    expect(searchParamsFromUrl(new URL("https://x/api/v1/logs?from=2026-11-17T20:20:00Z&to=1700000000000&order=asc&cursor=abc&exception=Boom"))).toMatchObject({
      from: "2026-11-17T20:20:00Z",
      to: "1700000000000",
      order: "asc",
      cursor: "abc",
      exception: "Boom",
    });
  });

  it("reads v1's parameters and prop.* operators", () => {
    const p = searchParamsFromUrl(new URL("https://x/v2/api/v1/logs?source=A&level=Error&limit=5&hours=2&trace_id=t&prop.Delta=>%3D3&prop.Env=prod"));
    expect(p).toMatchObject({ source: ["A"], level: "Error", limit: 5, hours: 2, traceId: "t" });
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
