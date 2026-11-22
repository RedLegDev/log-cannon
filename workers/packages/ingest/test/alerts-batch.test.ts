// Batched alert queries (refs #194): reading an alert query's output columns,
// composing the CROSS JOIN, and splitting the batched row back per alert.
import { describe, expect, it } from "vitest";
import { chunk, composeBatch, selectColumns, splitBatch } from "../src/alerts/batch";

describe("selectColumns", () => {
  it("reads every top-level AS name, in order, whatever the expressions hold", () => {
    expect(selectColumns("SELECT count(*) AS cnt FROM logs.events WHERE ts > now() - INTERVAL '5 minutes'")).toEqual(["cnt"]);
    expect(
      selectColumns(
        "SELECT coalesce(sum(c), 0) AS cnt, count(*) AS active_minutes, coalesce(max(c), 0) AS max_1min FROM (SELECT date_trunc('minute', ts) AS m, count(*) AS c FROM logs.events GROUP BY 1) t",
      ),
    ).toEqual(["cnt", "active_minutes", "max_1min"]);
    expect(
      selectColumns(
        "SELECT count(*) AS cnt, count(DISTINCT (regexp_match(message, '\\[([0-9a-f-]{36})\\]'))[1]) AS broken_alerts, max(substr(message, 1, 240)) AS sample FROM logs.events WHERE message LIKE '%a, b AS c%'",
      ),
    ).toEqual(["cnt", "broken_alerts", "sample"]);
    expect(selectColumns("SELECT CAST(x AS VARCHAR) AS last_done_at, CAST((a OR b) AS INT) AS stalled FROM t")).toEqual(["last_done_at", "stalled"]);
  });

  it("keeps case and quoted names as Basin does, and names a bare column after itself", () => {
    expect(selectColumns('SELECT count(*) AS Cnt, max(x) AS "Max, ""x""" FROM logs.events')).toEqual(["Cnt", 'Max, "x"']);
    expect(selectColumns("SELECT started, ads_done, CAST(last AS VARCHAR) AS last_at FROM (SELECT 1 AS started, 2 AS ads_done, 3 AS last)")).toEqual([
      "started",
      "ads_done",
      "last_at",
    ]);
  });

  it("allows a trailing semicolon and a query with no FROM", () => {
    expect(selectColumns("  SELECT 1 AS one ;  ")).toEqual(["one"]);
  });

  it("refuses what it can't name or what may not return exactly one row", () => {
    for (const sql of [
      "SELECT * FROM logs.events",
      "SELECT count(*) FROM logs.events",
      "SELECT count(*) cnt FROM logs.events",
      "SELECT 'x AS y' FROM logs.events",
      "SELECT source AS s, count(*) AS cnt FROM logs.events GROUP BY source",
      "SELECT ts AS t FROM logs.events ORDER BY ts DESC LIMIT 1",
      "SELECT 1 AS a UNION ALL SELECT 2 AS a",
      "SELECT DISTINCT level AS l FROM logs.events",
      "WITH x AS (SELECT 1 AS a) SELECT a AS a FROM x",
      "SELECT count(*) AS cnt FROM logs.events -- note",
      "SELECT 1 AS a; SELECT 2 AS b",
      "SELECT 1 AS a, 2 AS a",
      "SELECT 'unterminated AS a",
      "",
    ]) {
      expect(selectColumns(sql), sql).toBeNull();
    }
  });
});

describe("composeBatch and splitBatch", () => {
  const members = [
    { sql: "SELECT CAST(max(received_at) AS VARCHAR) AS newest FROM logs.events", columns: ["newest"] },
    { sql: "SELECT count(*) AS cnt FROM logs.events WHERE source = 'a';", columns: ["cnt"] },
    { sql: "SELECT count(*) AS cnt, count(*) AS active_minutes, max(x) AS \"Max\" FROM logs.events", columns: ["cnt", "active_minutes", "Max"] },
  ];

  it("CROSS JOINs each member as a derived table under positional output keys", () => {
    expect(composeBatch(members)).toBe(
      'SELECT t0."newest" AS "m0_0", t1."cnt" AS "m1_0", t2."cnt" AS "m2_0", t2."active_minutes" AS "m2_1", t2."Max" AS "m2_2" FROM ' +
        "(SELECT CAST(max(received_at) AS VARCHAR) AS newest FROM logs.events) t0 CROSS JOIN " +
        "(SELECT count(*) AS cnt FROM logs.events WHERE source = 'a') t1 CROSS JOIN " +
        '(SELECT count(*) AS cnt, count(*) AS active_minutes, max(x) AS "Max" FROM logs.events) t2',
    );
  });

  it("gives each member back its own row under its own column names", () => {
    const row = { m0_0: "2026-10-23T14:59:00", m1_0: 4, m2_0: 9, m2_1: 3, m2_2: null };
    expect(splitBatch([row], members)).toEqual([{ newest: "2026-10-23T14:59:00" }, { cnt: 4 }, { cnt: 9, active_minutes: 3, Max: null }]);
  });

  it("fails the batch on anything but one complete row", () => {
    expect(() => splitBatch([], members)).toThrow("returned 0 rows");
    expect(() => splitBatch([{}, {}], members)).toThrow("returned 2 rows");
    expect(() => splitBatch([{ m0_0: null, m1_0: 1, m2_0: 1, m2_1: 1 }], members)).toThrow("missing m2_2");
  });

  it("chunks in order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});
