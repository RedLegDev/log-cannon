import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SEND_CHARS,
  basinFailureCLEF,
  basinWriteEnabled,
  batchRows,
  writeCopy,
  type BasinCopy,
  type LogStream,
} from "../src/basin";
import { copyToBasin, type IngestRequest } from "../src/index";
import { assertRowValid, type LogRow } from "../src/parse/row";
import { __resetTelemetryThrottle } from "../src/timing";

const RECEIVED_AT = new Date("2026-10-22T00:00:00.000Z");
const utf8 = (s: string) => new TextEncoder().encode(s);

function fakeStream(fail?: (batch: number) => boolean) {
  const batches: LogRow[][] = [];
  const stream: LogStream = {
    send: async (records) => {
      if (fail?.(batches.length)) throw new Error("stream unavailable");
      batches.push(records);
    },
  };
  return { stream, batches };
}

function copy(over: Partial<BasinCopy> = {}): BasinCopy {
  return {
    format: "clef",
    body: utf8(
      '{"@t":"2026-10-21T12:00:00Z","@mt":"Hello {Name}","Name":"a"}\n' +
        '{"@t":"2026-10-21T12:00:01Z","@l":"Error","@m":"boom"}\n',
    ),
    contentType: "application/vnd.serilog.clef",
    source: "example-app",
    keyId: "key-1",
    receivedAt: RECEIVED_AT,
    ...over,
  };
}

describe("basinWriteEnabled", () => {
  const { stream } = fakeStream();
  it.each([
    ["true", true],
    [" true ", true],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["", false],
    [undefined, false],
  ])("flag %j → %s", (flag, want) => {
    expect(basinWriteEnabled(flag, stream)).toBe(want);
  });

  it("is off without a binding even when the flag is on", () => {
    expect(basinWriteEnabled("true", undefined)).toBe(false);
  });
});

describe("batchRows", () => {
  const row = (n: number) => ({ id: String(n).padStart(3, "0"), message: "x".repeat(100) }) as unknown as LogRow;

  it("keeps a small request in one send", () => {
    expect(batchRows([row(1), row(2)])).toHaveLength(1);
  });

  it("cuts batches under the cap and keeps every row in order", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const one = JSON.stringify(rows[0]).length + 1;
    const batches = batchRows(rows, one * 10 + 2);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 10, 10, 10]);
    expect(batches.flat().map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThanOrEqual(one * 10 + 2);
  });

  it("sends an oversized row alone instead of holding back its siblings", () => {
    const big = { id: "big", message: "y".repeat(5000) } as unknown as LogRow;
    const batches = batchRows([row(1), big, row(2)], 1000);
    expect(batches.map((b) => b.map((r) => r.id))).toEqual([["001"], ["big"], ["002"]]);
  });

  it("stays under the 5 MB stream cap even for 3-byte characters", () => {
    expect(MAX_SEND_CHARS * 3).toBeLessThan(5 * 1024 * 1024);
  });
});

describe("writeCopy", () => {
  it("sends valid rows stamped with the request's source, key and receive time", async () => {
    const { stream, batches } = fakeStream();
    const out = await writeCopy(stream, copy());
    expect(out).toEqual({ rows: 2, skipped: 0, sends: 1 });
    const rows = batches.flat();
    for (const r of rows) {
      assertRowValid(r);
      expect(r.source).toBe("example-app");
      expect(r.key_id).toBe("key-1");
      expect(r.received_at).toBe(RECEIVED_AT.toISOString());
      expect(r.format).toBe("clef");
    }
    expect(rows.map((r) => r.message)).toEqual(["Hello a", "boom"]);
  });

  it("parses webhook bodies with the preset", async () => {
    const { stream, batches } = fakeStream();
    await writeCopy(
      stream,
      copy({
        format: "webhook",
        contentType: "application/json",
        body: utf8('[{"message":"one","level":"warn"},{"message":"two"}]'),
      }),
    );
    expect(batches.flat().map((r) => r.format)).toEqual(["webhook", "webhook"]);
  });

  it("parses OTLP JSON logs and traces", async () => {
    const { stream, batches } = fakeStream();
    const logs = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "hi" } }] }] }],
    };
    const traces = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                  name: "GET /",
                  startTimeUnixNano: "1761000000000000000",
                  endTimeUnixNano: "1761000000005000000",
                },
              ],
            },
          ],
        },
      ],
    };
    await writeCopy(stream, copy({ format: "otlp-logs", contentType: "application/json", body: utf8(JSON.stringify(logs)) }));
    await writeCopy(stream, copy({ format: "otlp-traces", contentType: "application/json", body: utf8(JSON.stringify(traces)) }));
    const [log, span] = batches.flat();
    expect(log.kind).toBe("log");
    expect(span.kind).toBe("span");
    expect(span.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span.duration_ms).toBe(5);
  });

  it("throws on a send failure after the earlier batches went out", async () => {
    const { stream, batches } = fakeStream((n) => n === 1);
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ "@t": "2026-10-21T12:00:00Z", "@m": "z".repeat(900_000), N: i }),
    ).join("\n");
    await expect(writeCopy(stream, copy({ body: utf8(lines) }))).rejects.toThrow("stream unavailable");
    expect(batches).toHaveLength(1);
  });
});

describe("basinFailureCLEF", () => {
  it("is an Error for a lost send and a Warning for an unparseable body", () => {
    const base = { route: "/ingest/clef", format: "clef" as const, ingestSource: "a", bodyBytes: 10, error: "x" };
    expect(JSON.parse(basinFailureCLEF({ ...base, stage: "send" }, "t"))["@l"]).toBe("Error");
    expect(JSON.parse(basinFailureCLEF({ ...base, stage: "parse" }, "t"))["@l"]).toBe("Warning");
  });
});

describe("copyToBasin", () => {
  beforeEach(() => __resetTelemetryThrottle());

  function harness(vars: Record<string, unknown>, stream?: LogStream) {
    const pending: Promise<unknown>[] = [];
    const queued: unknown[] = [];
    const ingest = {
      request: new Request("https://logs.example.com/ingest/clef", { method: "POST" }),
      env: {
        INGEST_QUEUE: { send: async (m: unknown) => void queued.push(m) },
        SLOW_REQUEST_SOURCE: "log-cannon-ingest",
        LOGS: stream,
        ...vars,
      },
      ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} },
      route: "/ingest/clef",
      source: "example-app",
      keyId: "key-1",
      receivedAt: RECEIVED_AT,
    } as unknown as IngestRequest;
    const { format, body, contentType } = copy();
    return {
      run: () => copyToBasin(ingest, { format, body, contentType }),
      pending,
      queued,
    };
  }

  it("does nothing while BASIN_WRITE is off", () => {
    const { stream, batches } = fakeStream();
    const h = harness({ BASIN_WRITE: "false" }, stream);
    h.run();
    expect(h.pending).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it("copies in waitUntil when on", async () => {
    const { stream, batches } = fakeStream();
    const h = harness({ BASIN_WRITE: "true" }, stream);
    h.run();
    expect(h.pending).toHaveLength(1);
    await Promise.all(h.pending);
    expect(batches.flat()).toHaveLength(2);
    expect(h.queued).toHaveLength(0);
  });

  it("reports a failed send on both channels and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stream } = fakeStream(() => true);
    const h = harness({ BASIN_WRITE: "true" }, stream);
    h.run();
    await expect(Promise.all(h.pending)).resolves.toBeDefined();
    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ event: "basin-copy-failed", stage: "send", ingestSource: "example-app" });
    expect(h.queued).toHaveLength(1);
    expect((h.queued[0] as { source: string }).source).toBe("log-cannon-ingest");
    error.mockRestore();
  });
});
