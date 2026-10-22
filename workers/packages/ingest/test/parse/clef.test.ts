/** Port of queue-consumer/clef_test.go, plus the v2 row fields. */
import { describe, expect, it } from "vitest";
import { parseCLEF, parseCLEFLine } from "../../src/parse/clef";
import { ParseError } from "../../src/parse/row";
import { ctx, expectRowShape, RECEIVED_AT } from "./helpers";

function enrich(): Record<string, string> {
  return {
    cf_asn: "13335",
    geo_country: "US",
    geo_region: "Florida",
    geo_city: "Lakeland",
    cf_is_bot: "false",
    user_agent: "Mozilla/5.0",
  };
}

describe("applyEnrichment", () => {
  it("backfills every missing field on a browser beacon", () => {
    const row = parseCLEFLine(
      `{"@t":"2026-01-01T00:00:00Z","@mt":"beacon","page":"/read/1"}`,
      ctx("web", enrich()),
    );
    for (const [k, want] of Object.entries(enrich())) expect(row.properties[k]).toBe(want);
    expect(row.properties.page).toBe("/read/1");
  });

  it("never overwrites a caller's own geo/ASN", () => {
    const row = parseCLEFLine(
      `{"@t":"2026-01-01T00:00:00Z","@mt":"m","cf_asn":"64500","geo_country":"DE","geo_city":"Berlin","cf_is_bot":"true"}`,
      ctx("svc", enrich()),
    );
    expect(row.properties).toMatchObject({
      cf_asn: "64500",
      geo_country: "DE",
      geo_city: "Berlin",
      cf_is_bot: "true",
      geo_region: "Florida", // not provided by the caller, so still backfilled
    });
  });

  it("fills empty-string and null values", () => {
    const row = parseCLEFLine(
      `{"@t":"2026-01-01T00:00:00Z","@mt":"m","geo_country":"","geo_city":null}`,
      ctx("svc", enrich()),
    );
    expect(row.properties.geo_country).toBe("US");
    expect(row.properties.geo_city).toBe("Lakeland");
  });

  it("is a no-op without an enrichment map", () => {
    const row = parseCLEFLine(`{"@t":"2026-01-01T00:00:00Z","@mt":"m","only":"field"}`, ctx("svc"));
    expect(row.properties).toEqual({ only: "field" });
  });
});

describe("parseCLEF", () => {
  it("skips a bad line and keeps its siblings", () => {
    const body =
      `{"@t":"2026-01-01T00:00:00Z","@mt":"one"}\n` +
      `not-json\n` +
      `{"@t":"2026-01-01T00:00:01Z","@mt":"three"}\n`;
    const { rows, skipped } = parseCLEF(body, ctx());
    expect(rows.map((r) => r.message_template)).toEqual(["one", "three"]);
    expect(skipped).toBe(1);
  });

  it("rejects the body when every line fails", () => {
    expect(() => parseCLEF(`not-json\n{"@mt":"missing @t"}\n`, ctx())).toThrow(ParseError);
  });

  it("returns nothing for an empty body", () => {
    expect(parseCLEF("\n\n", ctx())).toEqual({ rows: [], skipped: 0 });
  });

  it("fills the v2 row fields", () => {
    const { rows } = parseCLEF(
      `{"@t":"2026-01-01T00:00:00.123456Z","@l":"Warning","@mt":"Hi {N}","N":"x"}\r\n`,
      ctx("svc"),
    );
    const [row] = rows;
    expectRowShape(row, expect);
    expect(row).toMatchObject({
      ts: "2026-01-01T00:00:00.123Z",
      source: "svc",
      format: "clef",
      kind: "log",
      level: "Warning",
      message: "Hi x",
      message_template: "Hi {N}",
      trace_id: null,
      span_id: null,
      parent_span_id: null,
      duration_ms: null,
      properties: { N: "x" },
    });
  });

  it("clamps a future timestamp to the receive time", () => {
    const [row] = parseCLEF(`{"@t":"2099-01-01T00:00:00Z","@mt":"m"}`, ctx()).rows;
    expect(row.ts).toBe(RECEIVED_AT.toISOString());
  });

  it("mints a distinct id per row", () => {
    const { rows } = parseCLEF(
      `{"@t":"2026-01-01T00:00:00Z","@mt":"a"}\n{"@t":"2026-01-01T00:00:00Z","@mt":"a"}`,
      ctx(),
    );
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});
