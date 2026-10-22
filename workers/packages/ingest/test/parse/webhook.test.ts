/** Port of queue-consumer/webhook_test.go, plus the v2 row fields. */
import { describe, expect, it } from "vitest";
import { parseWebhook } from "../../src/parse/webhook";
import { ParseError } from "../../src/parse/row";
import { ctx, expectRowShape, RECEIVED_AT } from "./helpers";

describe("parseWebhook", () => {
  it("parses a compact array", () => {
    const { rows } = parseWebhook(
      `[{"message":"a","level":"Info"},{"message":"b","level":"Error"}]`,
      ctx("webhook"),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source)).toEqual(["webhook", "webhook"]);
    expect(rows.map((r) => r.properties.message)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.level)).toEqual(["Info", "Error"]);
  });

  it("parses a pretty-printed array", () => {
    const body = `[
  {
    "message": "pretty-one",
    "level": "Warning"
  },
  {
    "message": "pretty-two",
    "level": "Error"
  }
]`;
    const { rows } = parseWebhook(body, ctx());
    expect(rows.map((r) => r.properties.message)).toEqual(["pretty-one", "pretty-two"]);
  });

  it("parses a single object", () => {
    const { rows } = parseWebhook(`{"message":"solo","level":"Information"}`, ctx("solo-src"));
    expect(rows).toHaveLength(1);
    expect(rows[0].properties.message).toBe("solo");
  });

  it("parses NDJSON", () => {
    expect(parseWebhook(`{"message":"line1"}\n{"message":"line2"}\n`, ctx()).rows).toHaveLength(2);
  });

  it("returns nothing for an empty array", () => {
    expect(parseWebhook(`[]`, ctx()).rows).toHaveLength(0);
  });

  it("rejects NDJSON where every line is malformed", () => {
    expect(() => parseWebhook("not-json\nalso-bad\n", ctx())).toThrow(ParseError);
  });

  it("skips array elements that aren't objects", () => {
    const { rows, skipped } = parseWebhook(
      `[{"message":"ok"},"skip-me",42,{"message":"also-ok"}]`,
      ctx(),
    );
    expect(rows).toHaveLength(2);
    expect(skipped).toBe(2);
  });

  it("applies the cloudflare preset", () => {
    const { rows } = parseWebhook(
      `[{"EdgeStartTimestamp":1700000000000000000,"ClientRequestMethod":"GET","ClientRequestHost":"example.com","ClientRequestURI":"/","EdgeResponseStatus":200}]`,
      ctx("cf"),
      "cloudflare",
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expectRowShape(row, expect);
    expect(row).toMatchObject({
      ts: "2023-11-14T22:13:20.000Z",
      source: "example.com",
      level: "Information",
      format: "webhook",
      kind: "log",
      message: "GET example.com/ → 200",
    });
    // The preset's own fields are excluded from properties.
    expect(row.properties).toEqual({ ClientRequestMethod: "GET", ClientRequestURI: "/" });
  });

  it("uses the receive time when an event has no timestamp", () => {
    const [row] = parseWebhook(`{"msg":"no time"}`, ctx()).rows;
    expect(row.ts).toBe(RECEIVED_AT.toISOString());
  });
});

describe("parseWebhook hostile input", () => {
  it("treats a timestamp too large for a Date as now instead of throwing", () => {
    const { rows } = parseWebhook(
      `{"time":-1e300}\n{"EdgeStartTimestamp":-1e300}\n{"ts":"-1e300"}`,
      ctx(),
    );
    expect(rows.map((r) => r.ts)).toEqual(Array(3).fill(RECEIVED_AT.toISOString()));
  });

  it("keeps a __proto__ key as a property", () => {
    const [row] = parseWebhook(`{"__proto__":{"polluted":true},"a":1}`, ctx()).rows;
    expect(Object.keys(row.properties)).toEqual(["__proto__", "a"]);
    expect(JSON.parse(JSON.stringify(row.properties))).toEqual(
      JSON.parse(`{"__proto__":{"polluted":true},"a":1}`),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
