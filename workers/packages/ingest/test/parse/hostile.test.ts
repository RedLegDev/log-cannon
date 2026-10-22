/**
 * Inputs a producer controls that must not break a row or its batch: `$`
 * patterns and amplification in templates, deep nesting, lone surrogates, and
 * timestamps outside RFC 3339's range. Every row that comes out must pass
 * assertRowValid, which is what the stream will accept.
 */
import { describe, expect, it } from "vitest";
import { parseCLEF } from "../../src/parse/clef";
import { parseWebhook } from "../../src/parse/webhook";
import { parseOTLPLogs, parseOTLPTraces } from "../../src/parse/otlp";
import { MAX_RENDERED_CHARS, renderMessageTemplate } from "../../src/parse/go-compat";
import { assertRowValid, MAX_NESTING_DEPTH, type LogRow } from "../../src/parse/row";
import { ctx, RECEIVED_AT, utf8 } from "./helpers";

function valid(rows: LogRow[]): LogRow[] {
  for (const row of rows) assertRowValid(row);
  return rows;
}

function nested(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = i % 2 ? [v] : { k: v };
  return v;
}

const T = `"@t":"2026-01-01T00:00:00Z"`;

describe("message templates", () => {
  it("substitutes $ patterns literally (Go parity)", () => {
    const [row] = valid(
      parseCLEF(`{${T},"@mt":"Price {P} {Q} {R} {S}","P":"$$5","Q":"$&","R":"$\`","S":"$'"}`, ctx()).rows,
    );
    expect(row.message).toBe("Price $$5 $& $` $'");
  });

  it("does not amplify $` into a memory bomb", () => {
    const line = `{${T},"@mt":"${"{A}".repeat(15000)}","A":"$\`"}`;
    const [row] = valid(parseCLEF(line, ctx()).rows);
    expect(row.message).toBe("$`".repeat(15000));
  });

  it("caps rendered output at MAX_RENDERED_CHARS, leaving the overflow placeholders literal", () => {
    const value = "x".repeat(100_000);
    const message = renderMessageTemplate("{V}".repeat(1000), { V: value });
    expect(message.length).toBeLessThanOrEqual(MAX_RENDERED_CHARS + 3000);
    const substituted = Math.floor(MAX_RENDERED_CHARS / value.length);
    expect(message).toBe(value.repeat(substituted) + "{V}".repeat(1000 - substituted));
  });

  it("never rescans a substituted value", () => {
    expect(renderMessageTemplate("{A} {B}", { A: "{B}", B: "b" })).toBe("{B} b");
  });
});

describe("nesting depth", () => {
  it(`skips a CLEF line nested past ${MAX_NESTING_DEPTH} levels and keeps its siblings`, () => {
    const deep = JSON.stringify({ "@t": "2026-01-01T00:00:00Z", "@mt": "deep", d: nested(5000) });
    const { rows, skipped } = parseCLEF(`${deep}\n{${T},"@mt":"ok"}`, ctx());
    expect(valid(rows).map((r) => r.message)).toEqual(["ok"]);
    expect(skipped).toBe(1);
  });

  it("accepts nesting right at the limit", () => {
    const line = JSON.stringify({ "@t": "2026-01-01T00:00:00Z", d: nested(MAX_NESTING_DEPTH - 1) });
    expect(valid(parseCLEF(line, ctx()).rows)).toHaveLength(1);
  });

  it("skips a deep webhook array element and keeps its siblings", () => {
    const body = JSON.stringify([{ m: "a" }, { d: nested(5000) }, { m: "b" }]);
    const { rows, skipped } = parseWebhook(body, ctx());
    expect(valid(rows).map((r) => r.properties.m)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("skips a deep webhook NDJSON line and keeps its siblings", () => {
    const body = `{"m":"a"}\n${JSON.stringify({ d: nested(5000) })}\n{"m":"b"}`;
    const { rows, skipped } = parseWebhook(body, ctx());
    expect(valid(rows).map((r) => r.properties.m)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  function deepAnyValue(depth: number): unknown {
    let v: unknown = { stringValue: "leaf" };
    for (let i = 0; i < depth; i++) v = { arrayValue: { values: [v] } };
    return v;
  }

  it("skips a deep OTLP JSON log record and keeps its siblings", () => {
    const body = utf8(
      JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  { body: { stringValue: "a" } },
                  { body: { stringValue: "deep" }, attributes: [{ key: "d", value: deepAnyValue(5000) }] },
                  { body: { stringValue: "b" } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const { rows, skipped } = parseOTLPLogs(body, "application/json", ctx());
    expect(valid(rows).map((r) => r.message)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("skips a deep OTLP protobuf span and keeps its siblings", () => {
    // Build bottom-up: AnyValue{array_value: ArrayValue{values: [inner]}}.
    const len = (n: number) => {
      const out: number[] = [];
      for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
      out.push(n);
      return out;
    };
    const field = (tag: number, payload: number[]) => [tag, ...len(payload.length), ...payload];
    let any = field(0x0a, [...utf8("leaf")]); // AnyValue.string_value
    for (let i = 0; i < 2000; i++) any = field(0x2a, field(0x0a, any)); // array_value{values}
    const attr = [...field(0x0a, [...utf8("d")]), ...field(0x12, any)]; // KeyValue
    const span = (name: string, extra: number[] = []) => field(0x12, [...field(0x2a, [...utf8(name)]), ...extra]);
    const scope = field(0x12, [...span("a"), ...span("deep", field(0x4a, attr)), ...span("b")]);
    const body = new Uint8Array(field(0x0a, scope));
    const { rows, skipped } = parseOTLPTraces(body, "application/x-protobuf", ctx());
    expect(valid(rows).map((r) => r.message)).toEqual(["a [UNSPECIFIED] OK", "b [UNSPECIFIED] OK"]);
    expect(skipped).toBe(1);
  });
});

describe("lone surrogates", () => {
  it("become U+FFFD in every CLEF string field, property key and value", () => {
    const line = `{${T},"@mt":"t\\ud800 {K}","@x":"x\\udc00","@l":"L\\ud800","K":"v\\udfff","k\\ud800":["\\udbff"]}`;
    const [row] = valid(parseCLEF(line, ctx("src\ud800")).rows);
    expect(row.message_template).toBe("t� {K}");
    expect(row.message).toBe("t� v�");
    expect(row.exception).toBe("x�");
    expect(row.level).toBe("L�");
    expect(row.source).toBe("src�");
    expect(row.properties).toEqual({ K: "v�", "k�": ["�"] });
  });

  it("become U+FFFD in webhook and OTLP rows", () => {
    valid(parseWebhook(`{"m":"\\ud800","level":"\\udc00"}`, ctx()).rows);
    const [row] = valid(
      parseOTLPLogs(
        utf8(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"\\ud800"},"attributes":[{"key":"\\udc00","value":{"stringValue":"\\ud800"}}]}]}]}]}`),
        "application/json",
        ctx(),
      ).rows,
    );
    expect(row.message).toBe("�");
    expect(row.properties).toEqual({ "�": "�" });
  });

  it("leave valid surrogate pairs alone", () => {
    const [row] = valid(parseCLEF(`{${T},"@m":"\\ud83d\\ude00"}`, ctx()).rows);
    expect(row.message).toBe("😀");
  });
});

describe("timestamps outside RFC 3339", () => {
  it("use the receive time for a CLEF year 0000", () => {
    const [row] = valid(parseCLEF(`{"@t":"0000-06-01T00:00:00Z","@mt":"m"}`, ctx()).rows);
    expect(row.ts).toBe(RECEIVED_AT.toISOString());
  });

  it("use the receive time for webhook numbers before year 1", () => {
    const rows = valid(parseWebhook(`{"time":-1e300}\n{"ts":-62135596801}\n{"ts":"-1e15"}`, ctx()).rows);
    expect(rows.map((r) => r.ts)).toEqual(Array(3).fill(RECEIVED_AT.toISOString()));
  });

  it("keep year 0001 itself", () => {
    const [row] = valid(parseCLEF(`{"@t":"0001-01-01T00:00:00Z","@mt":"m"}`, ctx()).rows);
    expect(row.ts).toBe("0001-01-01T00:00:00.000Z");
  });
});

describe("required fields", () => {
  it("defaults an empty CLEF @l to Information", () => {
    const [row] = valid(parseCLEF(`{${T},"@l":"","@mt":"m"}`, ctx()).rows);
    expect(row.level).toBe("Information");
  });

  it("computes received_at once per request", () => {
    const { rows } = parseCLEF(`{${T}}\n{${T}}`, ctx());
    expect(rows[0].received_at).toBe(rows[1].received_at);
  });
});

describe("assertRowValid", () => {
  const good = () => parseCLEF(`{${T},"@mt":"m"}`, ctx()).rows[0];
  it.each([
    ["empty level", (r: LogRow) => ({ ...r, level: "" })],
    ["non-RFC3339 ts", (r: LogRow) => ({ ...r, ts: "-001199-01-01T00:00:00.000Z" })],
    ["lone surrogate", (r: LogRow) => ({ ...r, message: "\ud800" })],
    ["bigint property", (r: LogRow) => ({ ...r, properties: { n: 1n } })],
    ["non-finite property", (r: LogRow) => ({ ...r, properties: { n: NaN } })],
    ["unknown format", (r: LogRow) => ({ ...r, format: "x" as LogRow["format"] })],
  ])("rejects %s", (_, mutate) => {
    expect(() => assertRowValid(mutate(good()))).toThrow(/invalid row/);
  });
});
