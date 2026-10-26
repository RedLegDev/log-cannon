import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BasinCopyError,
  MAX_SEND_CHARS,
  COPY_DEADLINE_MS,
  COPY_WATCHDOG_MS,
  SPILL_TIMEOUT_MS,
  isBasinLoss,
  SEND_RETRY_DELAYS_MS,
  SEND_TIMEOUT_MS,
  SPILL_PREFIX,
  gunzipRows,
  copyTiming,
  basinFailureCLEF,
  basinWriteEnabled,
  batchRows,
  classifyFailure,
  writeCopy,
  type BasinCopy,
  type LogStream,
} from "../src/basin";
import { copyToBasin, sendTelemetry, type IngestRequest } from "../src/index";
import { assertRowValid, type LogRow } from "../src/parse/row";
import { __resetTelemetryThrottle } from "../src/timing";

const RECEIVED_AT = new Date("2026-10-22T00:00:00.000Z");

// Retries sleep for real seconds; record the delays instead.
let slept: number[] = [];
const realSleep = copyTiming.sleep;
beforeEach(async () => {
  slept = [];
  copyTiming.sleep = async (ms) => void slept.push(ms);
  await clearSpill();
});
afterEach(() => {
  copyTiming.sleep = realSleep;
  copyTiming.timeoutMs = SEND_TIMEOUT_MS;
  copyTiming.spillTimeoutMs = SPILL_TIMEOUT_MS;
  copyTiming.watchdogMs = COPY_WATCHDOG_MS;
  vi.restoreAllMocks();
});

async function clearSpill() {
  const { objects } = await env.BASIN_SPILL.list();
  if (objects.length) await env.BASIN_SPILL.delete(objects.map((o) => o.key));
}

/** Every row in the spill bucket, oldest object first. */
async function spilledRows(): Promise<LogRow[]> {
  const { objects } = await env.BASIN_SPILL.list({ prefix: SPILL_PREFIX });
  const rows: LogRow[] = [];
  for (const o of objects) rows.push(...(await gunzipRows((await env.BASIN_SPILL.get(o.key))!.body)));
  return rows;
}

const noRetries = { rows: 0, skipped: 0, sends: 0, retries: 0, spilled: 0, lost: 0 };
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
    bodies: [
      utf8(
        '{"@t":"2026-10-21T12:00:00Z","@mt":"Hello {Name}","Name":"a"}\n' +
          '{"@t":"2026-10-21T12:00:01Z","@l":"Error","@m":"boom"}\n',
      ),
    ],
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
    expect(out).toEqual({ ...noRetries, rows: 2, sends: 1 });
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
        bodies: [utf8('[{"message":"one","level":"warn"},{"message":"two"}]')],
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
    await writeCopy(stream, copy({ format: "otlp-logs", contentType: "application/json", bodies: [utf8(JSON.stringify(logs))] }));
    await writeCopy(stream, copy({ format: "otlp-traces", contentType: "application/json", bodies: [utf8(JSON.stringify(traces))] }));
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
    await expect(writeCopy(stream, copy({ bodies: [utf8(lines)] }))).rejects.toMatchObject({
      stage: "send",
      message: "stream unavailable",
      outcome: { sends: 1, retries: SEND_RETRY_DELAYS_MS.length, lost: 2 },
    });
    expect(batches).toHaveLength(1);
  });

  it("parses a chunked body chunk by chunk and batches rows across chunks", async () => {
    const { stream, batches } = fakeStream();
    const chunk = (i: number) => utf8(`{"@t":"2026-10-21T12:00:0${i}Z","@m":"m${i}"}\n`);
    const out = await writeCopy(stream, copy({ bodies: [chunk(1), chunk(2), chunk(3)] }));
    expect(out).toEqual({ ...noRetries, rows: 3, sends: 1 });
    expect(batches.flat().map((r) => r.message)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps the other chunks when one fails to parse, then reports it as a parse failure", async () => {
    const { stream, batches } = fakeStream();
    const err = await writeCopy(
      stream,
      copy({
        bodies: [
          utf8('{"@t":"2026-10-21T12:00:00Z","@m":"a"}\n'),
          utf8("not json at all\n"),
          utf8('{"@t":"2026-10-21T12:00:02Z","@m":"c"}\n'),
        ],
      }),
    ).catch((e) => e);
    expect(classifyFailure(err)).toBe("parse");
    expect(err.outcome).toMatchObject({ rows: 2, skipped: 1 });
    expect(batches.flat().map((r) => r.message)).toEqual(["a", "c"]);
  });

  it("labels anything that isn't a BasinCopyError as a send failure", () => {
    expect(classifyFailure(new Error("x"))).toBe("send");
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
    const { format, bodies, contentType } = copy();
    return {
      run: (accepted: Promise<unknown> = Promise.resolve()) => copyToBasin(ingest, { format, bodies, contentType }, accepted),
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

  it("copies in waitUntil when on, without parsing before it returns", async () => {
    const { stream, batches } = fakeStream();
    const parsed = vi.spyOn(JSON, "stringify");
    const h = harness({ BASIN_WRITE: "true" }, stream);
    h.run();
    // Drain microtasks: the copy must still not have started, because the
    // handler sends its response after copyToBasin returns.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(parsed).not.toHaveBeenCalled();
    parsed.mockRestore();
    expect(h.pending).toHaveLength(1);
    await Promise.all(h.pending);
    expect(batches.flat()).toHaveLength(2);
    expect(h.queued).toHaveLength(0);
  });

  it("waits for the enqueue, and copies nothing if it was refused", async () => {
    const { stream, batches } = fakeStream();
    const h = harness({ BASIN_WRITE: "true" }, stream);
    let resolve!: () => void;
    h.run(new Promise<void>((r) => (resolve = r)));
    await scheduler.wait(1);
    expect(batches).toHaveLength(0);
    resolve();
    await Promise.all(h.pending);
    expect(batches.flat()).toHaveLength(2);

    const refused = harness({ BASIN_WRITE: "true" }, stream);
    refused.run(Promise.reject(new Error("queue unavailable")));
    await Promise.all(refused.pending);
    expect(batches.flat()).toHaveLength(2);
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

// --- retry and spill (refs #166) ----------------------------------------------

/** A stream whose send `n` (0-based, every attempt counted) fails when `fail(n)`.
 * It records what each attempt carried, sent or not. */
function flakyStream(fail: (attempt: number) => boolean) {
  const sent: LogRow[][] = [];
  const attempts: LogRow[][] = [];
  const stream: LogStream = {
    send: async (records) => {
      attempts.push(records);
      if (fail(attempts.length - 1)) throw new Error("CF_SB_EDGE_INGEST_ERROR: 10037");
      sent.push(records);
    },
  };
  return { stream, sent, attempts };
}

const big = (n: string) => JSON.stringify({ "@t": "2026-10-21T12:00:00Z", "@m": n, Pad: "z".repeat(900_000) });
const small = (n: string) => JSON.stringify({ "@t": "2026-10-21T12:00:00Z", "@m": n });
const ids = (rows: LogRow[]) => rows.map((r) => r.id);

describe("writeCopy retry and spill", () => {
  it("a send that fails then succeeds spills nothing", async () => {
    const { stream, sent } = flakyStream((n) => n === 0);
    const out = await writeCopy(stream, copy(), { spill: env.BASIN_SPILL });
    expect(out).toEqual({ ...noRetries, rows: 2, sends: 1, retries: 1 });
    expect(slept).toEqual([SEND_RETRY_DELAYS_MS[0]]);
    expect(sent.flat()).toHaveLength(2);
    expect(await spilledRows()).toEqual([]);
  });

  it("an always-failing send spills exactly the unsent rows, unparsed bodies included, none both sent and spilled", async () => {
    // Send 0 succeeds, every later attempt fails.
    const { stream, sent, attempts } = flakyStream((n) => n > 0);
    const bodies = [
      utf8(`${big("A")}\n${big("B")}\n`), // A goes out alone; B waits in the batcher
      utf8(`${small("C")}\n${small("D")}\n`),
      utf8(`${big("E")}\n`), // cuts [B,C,D], whose send fails
      utf8(`${small("F")}\n`), // parsed only after the stream is down
    ];
    const err = await writeCopy(stream, copy({ bodies }), { spill: env.BASIN_SPILL }).catch((e) => e);
    expect(err).toBeInstanceOf(BasinCopyError);
    expect(err.stage).toBe("send");
    expect(err.outcome).toMatchObject({ rows: 1, sends: 1, retries: 3, spilled: 5, lost: 0 });
    expect(err.spillError).toBeUndefined();
    expect(slept).toEqual([...SEND_RETRY_DELAYS_MS]);
    // No more sends after the retries ran out: E and F were never attempted.
    expect(attempts).toHaveLength(1 + 1 + SEND_RETRY_DELAYS_MS.length);

    const spilled = await spilledRows();
    expect(sent.flat().map((r) => r.message)).toEqual(["A"]);
    expect(spilled.map((r) => r.message)).toEqual(["B", "C", "D", "E", "F"]);
    const sentIds = new Set(ids(sent.flat()));
    expect(spilled.filter((r) => sentIds.has(r.id))).toEqual([]);
    for (const r of spilled) assertRowValid(r);

    // One object for the copy, keyed by its receive time.
    const { objects } = await env.BASIN_SPILL.list({ prefix: SPILL_PREFIX, include: ["customMetadata"] });
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toMatch(new RegExp(`^spill/${RECEIVED_AT.toISOString()}/[0-9a-f-]{36}\\.ndjson\\.gz$`));
    expect(objects[0].customMetadata).toEqual({ rows: "5" });
  });

  it("keeps the failing batch's ids in the spill", async () => {
    const { stream, attempts } = flakyStream(() => true);
    await writeCopy(stream, copy(), { spill: env.BASIN_SPILL }).catch(() => {});
    expect(ids(await spilledRows())).toEqual(ids(attempts[0]));
  });

  it("reports the rows as lost, with why, when the R2 put fails", async () => {
    const { stream } = flakyStream(() => true);
    const broken = { put: async () => { throw new Error("r2 unavailable"); } };
    const err = await writeCopy(stream, copy(), { spill: broken }).catch((e) => e);
    expect(err.outcome).toMatchObject({ spilled: 0, lost: 2 });
    expect(err.spillError).toBe("r2 unavailable");
  });

  it("stops retrying when a retry couldn't start inside the budget", async () => {
    const { stream, attempts } = flakyStream(() => true);
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 3_000));
    const err = await writeCopy(stream, copy(), { spill: env.BASIN_SPILL }).catch((e) => e);
    // The clock reads before each attempt and after each failure. At +6 s a
    // 500 ms retry fits under 12 s; at +12 s a 2 s one doesn't.
    expect(err.outcome).toMatchObject({ retries: 1, spilled: 2 });
    expect(attempts).toHaveLength(2);
  });
});

// --- hung sends and the copy deadline (refs #175) ------------------------------

describe("writeCopy time limits", () => {
  const never = () => new Promise<void>(() => {});

  it("a send that never settles times out, is retried, then spilled", async () => {
    copyTiming.timeoutMs = 5;
    const stream: LogStream = { send: never };
    const err = await writeCopy(stream, copy(), { spill: env.BASIN_SPILL }).catch((e) => e);
    expect(err).toBeInstanceOf(BasinCopyError);
    expect(err.message).toBe("send timed out after 5 ms");
    expect(err.outcome).toMatchObject({ sends: 0, retries: SEND_RETRY_DELAYS_MS.length, spilled: 2, lost: 0 });
    expect(await spilledRows()).toHaveLength(2);
  });

  it("a hung attempt followed by a good one spills nothing", async () => {
    copyTiming.timeoutMs = 5;
    const { stream: ok, sent } = flakyStream(() => false);
    let n = 0;
    const stream: LogStream = { send: (r) => (n++ === 0 ? never() : ok.send(r)) };
    const out = await writeCopy(stream, copy(), { spill: env.BASIN_SPILL });
    expect(out).toMatchObject({ rows: 2, sends: 1, retries: 1 });
    expect(sent.flat()).toHaveLength(2);
    expect(await spilledRows()).toEqual([]);
  });

  it("sends nothing more once the copy deadline passes, and spills the rest", async () => {
    const { stream, sent } = flakyStream(() => false);
    const t0 = 1_000_000;
    let reads = 0;
    // started, then the first batch's check, then everything after it is late.
    vi.spyOn(Date, "now").mockImplementation(() => (reads++ < 2 ? t0 : t0 + COPY_DEADLINE_MS));
    const bodies = [utf8(`${big("A")}\n${big("B")}\n`), utf8(`${small("C")}\n`)];
    const err = await writeCopy(stream, copy({ bodies }), { spill: env.BASIN_SPILL }).catch((e) => e);
    expect(err.message).toBe(`copy deadline of ${COPY_DEADLINE_MS} ms reached`);
    expect(err.outcome).toMatchObject({ rows: 1, sends: 1, retries: 0, spilled: 2 });
    expect(sent.flat().map((r) => r.message)).toEqual(["A"]);
    expect((await spilledRows()).map((r) => r.message)).toEqual(["B", "C"]);
  });
});

describe("spill and copy time limits", () => {
  const never = () => new Promise<never>(() => {});

  it("a spill put that never settles is reported as lost, not left hanging", async () => {
    copyTiming.spillTimeoutMs = 5;
    const { stream } = flakyStream(() => true);
    const err = await writeCopy(stream, copy(), { spill: { put: never } }).catch((e) => e);
    expect(err).toBeInstanceOf(BasinCopyError);
    expect(err.spillError).toBe("spill timed out after 5 ms");
    expect(err.outcome).toMatchObject({ spilled: 0, lost: 2 });
  });

  it("copyToBasin reports a copy that outlives the watchdog as a loss", async () => {
    __resetTelemetryThrottle();
    copyTiming.timeoutMs = 60_000;
    copyTiming.watchdogMs = 20;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const queued: { body: string }[] = [];
    let sends = 0;
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const ingest = {
      request: new Request("https://logs.example.com/ingest/clef", { method: "POST" }),
      env: {
        INGEST_QUEUE: { send: async (m: { body: string }) => void queued.push(m) },
        SLOW_REQUEST_SOURCE: "log-cannon-ingest",
        // Hangs until the test releases it, so nothing outlives the test.
        LOGS: { send: () => (sends++, hung) },
        BASIN_WRITE: "true",
        BASIN_SPILL: env.BASIN_SPILL,
      },
      ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} },
      route: "/ingest/clef",
      source: "example-app",
      keyId: "key-1",
      receivedAt: RECEIVED_AT,
    } as unknown as IngestRequest;
    const { format, bodies, contentType } = copy();
    copyToBasin(ingest, { format, bodies, contentType }, Promise.resolve());
    await Promise.all(pending);
    const logged = JSON.parse(error.mock.calls.find((c) => String(c[0]).includes("basin-copy-failed"))![0] as string);
    expect(logged).toMatchObject({ stage: "send", error: "copy timed out after 20 ms" });
    expect(queued).toHaveLength(1);
    const event = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(queued[0].body), (c) => c.charCodeAt(0))));
    expect(event).toMatchObject({ "@l": "Error", Error: "copy timed out after 20 ms" });
    // The report's Basin copy went to the spill without touching the stream.
    expect(sends).toBe(1);
    expect((await spilledRows()).map((r) => r.source)).toEqual(["log-cannon-ingest"]);
    release();
  });

  it("counts a send failure with no spill outcome as a loss", () => {
    const base = { route: "/r", format: "clef" as const, ingestSource: "a", bodyBytes: 1, error: "x" };
    expect(isBasinLoss({ ...base, stage: "send" })).toBe(true);
    expect(isBasinLoss({ ...base, stage: "send", spilledRows: 2, lostRows: 0 })).toBe(false);
    expect(isBasinLoss({ ...base, stage: "send", spilledRows: 1, lostRows: 1 })).toBe(true);
    expect(isBasinLoss({ ...base, stage: "parse" })).toBe(false);
  });
});

describe("writeCopy partial parse skips", () => {
  it("sends the good records and reports the skipped ones as a parse failure", async () => {
    const { stream, batches } = fakeStream();
    const body = utf8(`${small("a")}\nnot json\n${small("b")}\n`);
    const err = await writeCopy(stream, copy({ bodies: [body] })).catch((e) => e);
    expect(err).toBeInstanceOf(BasinCopyError);
    expect(err.stage).toBe("parse");
    expect(err.message).toBe("1 unparseable record(s) skipped");
    expect(err.outcome).toMatchObject({ rows: 2, skipped: 1 });
    expect(batches.flat().map((r) => r.message)).toEqual(["a", "b"]);
  });
});

describe("copyToBasin spill reporting", () => {
  beforeEach(() => __resetTelemetryThrottle());

  async function run(spill: unknown) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const queued: { body: string }[] = [];
    const ingest = {
      request: new Request("https://logs.example.com/ingest/clef", { method: "POST" }),
      env: {
        INGEST_QUEUE: { send: async (m: { body: string }) => void queued.push(m) },
        SLOW_REQUEST_SOURCE: "log-cannon-ingest",
        LOGS: flakyStream(() => true).stream,
        BASIN_WRITE: "true",
        BASIN_SPILL: spill,
      },
      ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} },
      route: "/ingest/clef",
      source: "example-app",
      keyId: "key-1",
      receivedAt: RECEIVED_AT,
    } as unknown as IngestRequest;
    const { format, bodies, contentType } = copy();
    copyToBasin(ingest, { format, bodies, contentType }, Promise.resolve());
    await Promise.all(pending);
    const logged = JSON.parse(error.mock.calls.find((c) => String(c[0]).includes("basin-copy-failed"))![0] as string);
    const event = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(queued[0].body), (c) => c.charCodeAt(0))));
    return { logged, event };
  }

  it("reports a spilled copy as a Warning with the spilled row count", async () => {
    const { logged, event } = await run(env.BASIN_SPILL);
    expect(logged).toMatchObject({ stage: "send", spilledRows: 2, lostRows: 0 });
    expect(event).toMatchObject({ "@l": "Warning", SpilledRows: 2, LostRows: 0 });
    // The copy's two rows, and the failure report's own Basin copy, which went
    // straight to the spill.
    expect((await spilledRows()).map((r) => r.source).sort()).toEqual(["example-app", "example-app", "log-cannon-ingest"]);
  });

  it("reports an R2 put failure as an Error with the lost row count", async () => {
    const { logged, event } = await run({ put: async () => { throw new Error("r2 unavailable"); } });
    expect(logged).toMatchObject({ spilledRows: 0, lostRows: 2, spillError: "r2 unavailable" });
    expect(event).toMatchObject({ "@l": "Error", LostRows: 2, SpillError: "r2 unavailable" });
  });

  it("a loss still reports when a spill report just used the throttle", async () => {
    await run(env.BASIN_SPILL);
    const { event } = await run({ put: async () => { throw new Error("r2 unavailable"); } });
    expect(event).toMatchObject({ "@l": "Error", LostRows: 2 });
  });
});

describe("sendTelemetry spill", () => {
  it("spills the Worker's own event when the stream won't take it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const line = JSON.stringify({ "@t": "2026-10-23T15:30:00Z", "@mt": "Basin copy failed", Stage: "send" });
    await sendTelemetry(
      { ...env, INGEST_QUEUE: { send: async () => {} }, LOGS: flakyStream(() => true).stream, BASIN_WRITE: "true", BASIN_SPILL: env.BASIN_SPILL } as never,
      "log-cannon-ingest",
      [line],
    );
    const rows = await spilledRows();
    expect(rows.map((r) => [r.source, r.key_id, r.message_template])).toEqual([["log-cannon-ingest", "log-cannon-ingest", "Basin copy failed"]]);
    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({ event: "telemetry-basin-copy-failed", spilledRows: 1, lostRows: 0 });
  });
});

describe("basinFailureCLEF spill fields", () => {
  const base = { route: "/ingest/clef", format: "clef" as const, ingestSource: "a", bodyBytes: 10, error: "x", stage: "send" as const };
  it("is a Warning only when every unsent row was spilled", () => {
    expect(JSON.parse(basinFailureCLEF({ ...base, spilledRows: 5, lostRows: 0 }, "t"))["@l"]).toBe("Warning");
    expect(JSON.parse(basinFailureCLEF({ ...base, spilledRows: 0, lostRows: 5 }, "t"))["@l"]).toBe("Error");
    expect(JSON.parse(basinFailureCLEF(base, "t"))["@l"]).toBe("Error");
  });
});
