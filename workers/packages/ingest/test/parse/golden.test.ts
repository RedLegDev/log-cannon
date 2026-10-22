/**
 * Parity with the Go queue-consumer. golden.json is the Go parsers' own output
 * (clef.go, webhook.go, otlp.go, hash.go at 05e2a64) for the inputs it lists,
 * produced by a one-off Go test that called those functions directly. Every
 * expectation here comes from Go, not from this port.
 *
 * Deliberate v2 differences, applied before comparing:
 * - span traceId/spanId/parentSpanId/durationMs move from properties to columns;
 * - Go's "now" (an event with no usable time) is the request's receivedAt.
 */
import { describe, expect, it } from "vitest";
import golden from "./golden.json";
import { parseCLEF } from "../../src/parse/clef";
import { parseWebhook } from "../../src/parse/webhook";
import { parseOTLPLogs, parseOTLPTraces } from "../../src/parse/otlp";
import {
  computeEventType,
  goFormatG,
  goJSON,
  renderMessageTemplate,
} from "../../src/parse/go-compat";
import { ParseError, type LogRow, type ParseResult } from "../../src/parse/row";
import { base64Bytes, ctx, expectRowShape, RECEIVED_AT } from "./helpers";

interface GoEvent {
  ts: string;
  level: string;
  message_template: string;
  message: string;
  exception: string;
  event_type: string;
  source: string;
  properties: Record<string, unknown>;
}

interface GoCase {
  name: string;
  body?: string;
  body_b64?: string;
  content_type?: string;
  preset?: string;
  source: string;
  enrich?: Record<string, string>;
  events: GoEvent[] | null;
  error?: string;
}

const SPAN_PROPS = ["traceId", "spanId", "parentSpanId", "durationMs"];

function compare(rows: LogRow[], events: GoEvent[], spans: boolean): void {
  expect(rows).toHaveLength(events.length);
  rows.forEach((row, i) => {
    const want = events[i];
    expectRowShape(row, expect);
    expect(row.ts).toBe(want.ts === "now" ? RECEIVED_AT.toISOString() : want.ts);
    expect({
      level: row.level,
      message_template: row.message_template,
      message: row.message,
      exception: row.exception,
      event_type: row.event_type,
      source: row.source,
    }).toEqual({
      level: want.level,
      message_template: want.message_template,
      message: want.message,
      exception: want.exception,
      event_type: want.event_type,
      source: want.source,
    });
    const props = { ...want.properties };
    if (spans) {
      expect(row.kind).toBe("span");
      expect(row.trace_id).toBe((props.traceId as string) || null);
      expect(row.span_id).toBe((props.spanId as string) || null);
      expect(row.parent_span_id).toBe((props.parentSpanId as string | undefined) ?? null);
      expect(row.duration_ms).toBe((props.durationMs as number | undefined) ?? null);
      for (const k of SPAN_PROPS) delete props[k];
    }
    // Compared as serialized for the stream: Vite's JSON import has already
    // turned the fixture's -0 into 0, and JSON.stringify does the same to ours.
    expect(JSON.parse(JSON.stringify(row.properties))).toEqual(props);
  });
}

function check(c: GoCase, run: () => ParseResult, spans = false): void {
  if (c.error) {
    expect(run).toThrow(ParseError);
    return;
  }
  compare(run().rows, c.events ?? [], spans);
}

describe("golden: computeEventType", () => {
  it.each(golden.hashes)("$in", ({ in: input, out }) => {
    expect(computeEventType(input, "")).toBe(out);
    expect(computeEventType("", input)).toBe(out);
  });
});

describe("golden: float formatting", () => {
  it.each(golden.floats)("$g", ({ bits, g, template }) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt("0x" + bits));
    const f = view.getFloat64(0);
    expect(goFormatG(f)).toBe(g);
    expect(renderMessageTemplate("{v}", { v: f })).toBe(template);
  });
});

describe("golden: json.Marshal", () => {
  it.each(golden.json)("$in", ({ in: input, out }) => {
    expect(goJSON(JSON.parse(input))).toBe(out);
  });
});

describe("golden: CLEF", () => {
  it.each(golden.clef as GoCase[])("$name", (c) => {
    check(c, () => parseCLEF(c.body!, ctx(c.source, c.enrich)));
  });
});

describe("golden: webhook", () => {
  it.each(golden.webhook as GoCase[])("$name", (c) => {
    check(c, () => parseWebhook(c.body!, ctx(c.source), c.preset));
  });
});

describe("golden: OTLP logs", () => {
  it.each(golden.otlp_logs as GoCase[])("$name", (c) => {
    check(c, () => parseOTLPLogs(base64Bytes(c.body_b64 ?? ""), c.content_type!, ctx(c.source)));
  });
});

describe("golden: OTLP traces", () => {
  it.each(golden.otlp_traces as GoCase[])("$name", (c) => {
    check(c, () => parseOTLPTraces(base64Bytes(c.body_b64 ?? ""), c.content_type!, ctx(c.source)), true);
  });
});
