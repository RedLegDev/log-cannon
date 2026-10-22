/**
 * OTLP behaviour specific to v2 (Go parity is in golden.test.ts): span fields
 * as columns, hex ids in JSON, trace context on log records, and values Go
 * mishandled.
 */
import { describe, expect, it } from "vitest";
import { parseOTLPLogs, parseOTLPTraces } from "../../src/parse/otlp";
import { ParseError } from "../../src/parse/row";
import { ctx, expectRowShape, hexBytes, utf8 } from "./helpers";

const TRACE = "0102030405060708090a0b0c0d0e0f10";
const SPAN = "a1a2a3a4a5a6a7a8";
const PARENT = "b1b2b3b4b5b6b7b8";

function json(v: unknown): Uint8Array {
  return utf8(JSON.stringify(v));
}

describe("OTLP traces", () => {
  const body = json({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: SPAN,
                parentSpanId: PARENT,
                name: "GET /x",
                kind: "SPAN_KIND_SERVER",
                startTimeUnixNano: "1767225600123456789",
                endTimeUnixNano: "1767225600135802467",
                attributes: [{ key: "http.status_code", value: { intValue: "500" } }],
                status: { code: "STATUS_CODE_ERROR", message: "boom" },
              },
              {
                name: "ended before it started",
                startTimeUnixNano: "2000",
                endTimeUnixNano: "1000",
              },
            ],
          },
        ],
      },
    ],
  });

  it("promotes span identity and duration to columns, reading ids as hex", () => {
    const { rows } = parseOTLPTraces(body, "application/json", ctx("key-name"));
    const [row] = rows;
    expectRowShape(row, expect);
    expect(row).toMatchObject({
      ts: "2026-01-01T00:00:00.123Z",
      source: "api",
      format: "otlp",
      kind: "span",
      level: "Error",
      message: "GET /x [SERVER] ERROR: boom",
      message_template: "{Name} [{Kind}] {Status}",
      trace_id: TRACE,
      span_id: SPAN,
      parent_span_id: PARENT,
      duration_ms: 12.345678,
      properties: { "http.status_code": 500 },
    });
  });

  it("leaves a negative duration null instead of wrapping it", () => {
    const row = parseOTLPTraces(body, "application/json", ctx()).rows[1];
    expect(row.duration_ms).toBeNull();
    expect(row.trace_id).toBeNull();
    expect(row.parent_span_id).toBeNull();
  });

  it("still accepts base64 ids (what protojson produced)", () => {
    const b64 = json({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "AQIDBAUGBwgJCgsMDQ4PEA==", name: "s" }] }] }],
    });
    expect(parseOTLPTraces(b64, "application/json", ctx()).rows[0].trace_id).toBe(TRACE);
  });
});

describe("OTLP logs", () => {
  it("carries trace context from the log record", () => {
    const { rows } = parseOTLPLogs(
      json({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: 1767225600000000000,
                    severityText: "INFO",
                    body: { stringValue: "hi" },
                    traceId: TRACE,
                    spanId: SPAN,
                  },
                ],
              },
            ],
          },
        ],
      }),
      "application/json",
      ctx("fallback"),
    );
    expect(rows[0]).toMatchObject({
      source: "fallback",
      kind: "log",
      level: "Information",
      message: "hi",
      trace_id: TRACE,
      span_id: SPAN,
      parent_span_id: null,
      duration_ms: null,
    });
  });

  it("keeps an int64 beyond 2^53 exact as a string, and stringifies non-finite doubles", () => {
    const { rows } = parseOTLPLogs(
      json({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { intValue: "9007199254740993" },
                    attributes: [
                      { key: "big", value: { intValue: "9007199254740993" } },
                      { key: "small", value: { intValue: "12" } },
                      { key: "nan", value: { doubleValue: "NaN" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      "application/json",
      ctx(),
    );
    expect(rows[0].message).toBe("9007199254740993");
    expect(rows[0].properties).toEqual({ big: "9007199254740993", small: 12, nan: "NaN" });
  });

  it("keeps a __proto__ attribute key as a property", () => {
    const { rows } = parseOTLPLogs(
      json({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      { key: "__proto__", value: { kvlistValue: { values: [{ key: "x", value: { intValue: "1" } }] } } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      "application/json",
      ctx(),
    );
    expect(Object.keys(rows[0].properties)).toEqual(["__proto__"]);
    expect(JSON.stringify(rows[0].properties)).toBe(`{"__proto__":{"x":1}}`);
  });

  it("reads snake_case field names and enum names", () => {
    const { rows } = parseOTLPLogs(
      json({
        resource_logs: [
          {
            scope_logs: [
              { log_records: [{ severity_number: "SEVERITY_NUMBER_ERROR2", body: { string_value: "x" } }] },
            ],
          },
        ],
      }),
      "application/json",
      ctx(),
    );
    expect(rows[0].level).toBe("Error");
  });

  it("rejects a protobuf string that isn't valid UTF-8", () => {
    // resource_logs{ scope_logs{ log_records{ severity_text: "\xff" } } }
    const body = hexBytes("0a07120512031a01ff");
    expect(() => parseOTLPLogs(body, "application/x-protobuf", ctx())).toThrow(/UTF-8/);
  });

  it("rejects a body that is neither JSON nor protobuf", () => {
    expect(() => parseOTLPLogs(utf8("{nope"), "application/json", ctx())).toThrow(ParseError);
  });
});
