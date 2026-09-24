import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SLOW_REQUEST_MS,
  RequestTrace,
  TELEMETRY_MIN_INTERVAL_MS,
  __resetTelemetryThrottle,
  buildSlowRequest,
  enqueueFailureCLEF,
  resolveSlowRequestMs,
  shouldEmitTelemetry,
  slowRequestCLEF,
} from "../src/timing";
import { reportEnqueueFailure, reportIfSlow, type IngestRequest } from "../src/index";

/** A clock the test drives by hand, standing in for Workers' I/O-stepped one. */
function fakeClock(start = 1_000) {
  const state = { t: start };
  return {
    state,
    now: () => state.t,
    advance(ms: number) {
      state.t += ms;
    },
  };
}

describe("RequestTrace", () => {
  it("attributes elapsed time to the phase that was open", () => {
    const clock = fakeClock();
    const trace = new RequestTrace(clock.now);

    clock.advance(4800);
    trace.mark("auth");
    clock.advance(5);
    trace.mark("read");
    clock.advance(120);
    trace.mark("enqueue");

    expect(trace.span("auth")).toBe(4800);
    expect(trace.span("read")).toBe(5);
    expect(trace.span("enqueue")).toBe(120);
    expect(trace.totalMs()).toBe(4925);
  });

  it("accumulates a phase marked more than once", () => {
    const clock = fakeClock();
    const trace = new RequestTrace(clock.now);

    clock.advance(30);
    trace.mark("enqueue");
    clock.advance(70);
    trace.mark("enqueue");

    expect(trace.span("enqueue")).toBe(100);
  });

  it("reports 0 for phases that never ran", () => {
    const trace = new RequestTrace(fakeClock().now);
    expect(trace.span("read")).toBe(0);
    expect(trace.span("enqueue")).toBe(0);
  });
});

describe("resolveSlowRequestMs", () => {
  it("takes a numeric string, which is how wrangler vars arrive", () => {
    expect(resolveSlowRequestMs("2500")).toBe(2500);
  });

  it("takes a number", () => {
    expect(resolveSlowRequestMs(2500)).toBe(2500);
  });

  it("treats 0 as disabled rather than as 'report everything'", () => {
    expect(resolveSlowRequestMs("0")).toBe(0);
  });

  it("falls back to the default when unset or unparseable, never to off", () => {
    for (const raw of [undefined, null, "", "nonsense", NaN, -1]) {
      expect(resolveSlowRequestMs(raw)).toBe(DEFAULT_SLOW_REQUEST_MS);
    }
  });
});

describe("slowRequestCLEF", () => {
  const report = {
    route: "/ingest/clef",
    format: "clef",
    status: 201,
    ingestSource: "example-app",
    totalMs: 5231,
    authMs: 5100,
    readMs: 4,
    enqueueMs: 127,
    keyCacheHit: false,
    bodyBytes: 812,
    queueMessages: 1,
    colo: "IAD",
    rayId: "ray-1",
  };

  it("renders one newline-terminated CLEF line", () => {
    const line = slowRequestCLEF(report, "2026-09-24T00:00:00.000Z");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  it("carries the phase breakdown as queryable properties", () => {
    const e = JSON.parse(slowRequestCLEF(report, "2026-09-24T00:00:00.000Z"));
    expect(e["@l"]).toBe("Warning");
    expect(e.TotalMs).toBe(5231);
    expect(e.AuthMs).toBe(5100);
    expect(e.ReadMs).toBe(4);
    expect(e.EnqueueMs).toBe(127);
    expect(e.KeyCacheHit).toBe(false);
    expect(e.Route).toBe("/ingest/clef");
    expect(e.IngestSource).toBe("example-app");
  });

  it("keeps @mt constant so the consumer's event_type groups these together", () => {
    const a = JSON.parse(slowRequestCLEF(report, "2026-09-24T00:00:00.000Z"));
    const b = JSON.parse(
      slowRequestCLEF(
        { ...report, totalMs: 9, authMs: 9, route: "/v1/logs" },
        "2026-09-24T00:00:01.000Z",
      ),
    );
    expect(b["@mt"]).toBe(a["@mt"]);
  });

  it("omits colo and ray id when the edge did not supply them", () => {
    const e = JSON.parse(
      slowRequestCLEF(
        { ...report, colo: undefined, rayId: undefined },
        "2026-09-24T00:00:00.000Z",
      ),
    );
    expect("Colo" in e).toBe(false);
    expect("RayId" in e).toBe(false);
  });

  it("omits EnqueueHandedOff unless the caller stopped waiting for the ack", () => {
    // Default (QUEUE_ACK_DEADLINE_MS = 0) events stay byte-identical to the
    // ones emitted before the deadline existed.
    const off = JSON.parse(slowRequestCLEF(report, "2026-09-24T00:00:00.000Z"));
    expect("EnqueueHandedOff" in off).toBe(false);

    const on = JSON.parse(
      slowRequestCLEF(
        { ...report, enqueueHandedOff: true },
        "2026-09-24T00:00:00.000Z",
      ),
    );
    expect(on.EnqueueHandedOff).toBe(true);
  });
});

describe("enqueueFailureCLEF", () => {
  const failure = {
    route: "/ingest/clef",
    format: "clef",
    ingestSource: "example-app",
    queueMessages: 3,
    bodyBytes: 140_000,
    waitedMs: 250,
    error: "queue unavailable",
    colo: "IAD",
    rayId: "ray-1",
  };

  it("renders one newline-terminated CLEF line at Error level", () => {
    const line = enqueueFailureCLEF(failure, "2026-09-24T00:00:00.000Z");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)["@l"]).toBe("Error");
  });

  it("names what was lost, for whom, and why", () => {
    const e = JSON.parse(enqueueFailureCLEF(failure, "2026-09-24T00:00:00.000Z"));
    expect(e.Route).toBe("/ingest/clef");
    expect(e.IngestSource).toBe("example-app");
    expect(e.QueueMessages).toBe(3);
    expect(e.BodyBytes).toBe(140_000);
    expect(e.WaitedMs).toBe(250);
    expect(e.Error).toBe("queue unavailable");
  });

  it("uses a different @mt from slowRequestCLEF, so event_type separates them", () => {
    const loss = JSON.parse(
      enqueueFailureCLEF(failure, "2026-09-24T00:00:00.000Z"),
    );
    const slow = JSON.parse(
      slowRequestCLEF(
        {
          route: "/ingest/clef",
          format: "clef",
          status: 201,
          ingestSource: "example-app",
          totalMs: 1,
          authMs: 0,
          readMs: 0,
          enqueueMs: 1,
          keyCacheHit: true,
          bodyBytes: 1,
          queueMessages: 1,
        },
        "2026-09-24T00:00:00.000Z",
      ),
    );
    expect(loss["@mt"]).not.toBe(slow["@mt"]);
  });
});

describe("shouldEmitTelemetry", () => {
  beforeEach(() => __resetTelemetryThrottle());

  it("allows the first emission and suppresses the rest of the interval", () => {
    expect(shouldEmitTelemetry(10_000)).toBe(true);
    expect(shouldEmitTelemetry(10_001)).toBe(false);
    expect(
      shouldEmitTelemetry(10_000 + TELEMETRY_MIN_INTERVAL_MS - 1),
    ).toBe(false);
  });

  it("allows another once the interval has passed", () => {
    expect(shouldEmitTelemetry(10_000)).toBe(true);
    expect(shouldEmitTelemetry(10_000 + TELEMETRY_MIN_INTERVAL_MS)).toBe(true);
  });

  it("budgets each channel separately, so a slow-request burst cannot hide a loss", () => {
    expect(shouldEmitTelemetry(10_000, "slow-request")).toBe(true);
    expect(shouldEmitTelemetry(10_001, "slow-request")).toBe(false);
    // The rarer event still gets through — it marks events that are gone.
    expect(shouldEmitTelemetry(10_001, "enqueue-failure")).toBe(true);
    expect(shouldEmitTelemetry(10_002, "enqueue-failure")).toBe(false);
  });
});

// --- reportIfSlow ---------------------------------------------------------

function slowTrace(totalMs: number, keyCacheHit = false) {
  const clock = fakeClock();
  const trace = new RequestTrace(clock.now);
  clock.advance(totalMs);
  trace.mark("auth");
  trace.keyCacheHit = keyCacheHit;
  trace.bodyBytes = 812;
  trace.queueMessages = 1;
  return trace;
}

function harness(vars: Record<string, string> = {}) {
  const sent: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const env = {
    INGEST_QUEUE: {
      send: async (m: unknown) => {
        sent.push(m);
      },
    },
    KEYS_DB: undefined,
    SLOW_REQUEST_MS: "1000",
    SLOW_REQUEST_SOURCE: "log-cannon-ingest",
    ...vars,
  };
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  };
  const request = new Request("https://logs.example.com/ingest/clef", {
    method: "POST",
    headers: { "cf-ray": "ray-abc" },
  });
  const fields = {
    route: "/ingest/clef",
    format: "clef",
    status: 201,
    ingestSource: "example-app",
  };
  // `Env` and `ExecutionContext` are structural here; the stubs supply only
  // what reportIfSlow reaches for.
  const run = (trace: RequestTrace) =>
    reportIfSlow(
      request,
      env as never,
      ctx as unknown as ExecutionContext,
      trace,
      fields,
    );
  return { run, sent, pending };
}

describe("reportIfSlow", () => {
  beforeEach(() => __resetTelemetryThrottle());

  it("says nothing for a request under the threshold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.run(slowTrace(400));
    expect(warn).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    warn.mockRestore();
  });

  it("warns and enqueues a CLEF event once the threshold is reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.run(slowTrace(5200));

    expect(warn).toHaveBeenCalledTimes(1);
    const warned = JSON.parse(warn.mock.calls[0][0] as string);
    expect(warned.event).toBe("slow-ingest-request");
    expect(warned.totalMs).toBe(5200);
    expect(warned.authMs).toBe(5200);
    expect(warned.rayId).toBe("ray-abc");
    warn.mockRestore();

    await Promise.all(h.pending);
    expect(h.sent).toHaveLength(1);
    const msg = h.sent[0] as { format: string; source: string; body: string };
    expect(msg.format).toBe("clef");
    expect(msg.source).toBe("log-cannon-ingest");
    const event = JSON.parse(atob(msg.body));
    expect(event.TotalMs).toBe(5200);
    expect(event.IngestSource).toBe("example-app");
  });

  it("records whether the key came from cache, so a cold isolate is distinguishable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    harness().run(slowTrace(5200, true));
    expect(JSON.parse(warn.mock.calls[0][0] as string).keyCacheHit).toBe(true);
    warn.mockRestore();
  });

  it("reports nothing at all when SLOW_REQUEST_MS is 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ SLOW_REQUEST_MS: "0" });
    h.run(slowTrace(30_000));
    expect(warn).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    warn.mockRestore();
  });

  it("still warns when SLOW_REQUEST_SOURCE is empty, but enqueues nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ SLOW_REQUEST_SOURCE: "" });
    h.run(slowTrace(5200));
    expect(warn).toHaveBeenCalledTimes(1);
    await Promise.all(h.pending);
    expect(h.sent).toHaveLength(0);
    warn.mockRestore();
  });

  it("throttles the queue event but never the warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.run(slowTrace(5200));
    h.run(slowTrace(5300));
    h.run(slowTrace(5400));

    expect(warn).toHaveBeenCalledTimes(3);
    await Promise.all(h.pending);
    expect(h.sent).toHaveLength(1);
    warn.mockRestore();
  });

  it("swallows a queue failure instead of failing the served request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const env = {
      INGEST_QUEUE: {
        send: async () => {
          throw new Error("queue unavailable");
        },
      },
      SLOW_REQUEST_MS: "1000",
      SLOW_REQUEST_SOURCE: "log-cannon-ingest",
    };
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    };
    expect(() =>
      reportIfSlow(
        new Request("https://logs.example.com/ingest/clef", { method: "POST" }),
        env as never,
        ctx as unknown as ExecutionContext,
        slowTrace(5200),
        {
          route: "/ingest/clef",
          format: "clef",
          status: 201,
          ingestSource: "example-app",
        },
      ),
    ).not.toThrow();

    await expect(Promise.all(pending)).resolves.toBeDefined();
    const events = warn.mock.calls.map(
      (c) => JSON.parse(c[0] as string).event as string,
    );
    expect(events).toContain("slow-ingest-report-failed");
    warn.mockRestore();
  });
});

describe("buildSlowRequest", () => {
  function tracedEnqueue(handedOff: boolean) {
    const clock = fakeClock();
    const trace = new RequestTrace(clock.now);
    clock.advance(300);
    trace.enqueued(4, handedOff);
    return buildSlowRequest(trace, {
      route: "/ingest/clef",
      format: "clef",
      status: 201,
      ingestSource: "example-app",
    });
  }

  it("carries the queue-ack handoff through only when one happened", () => {
    expect("enqueueHandedOff" in tracedEnqueue(false)).toBe(false);
    expect(tracedEnqueue(true).enqueueHandedOff).toBe(true);
  });

  it("keeps EnqueueMs as the time the caller actually waited", () => {
    // 300 ms either way: the full send when it acked in time, the deadline
    // when it did not. `enqueueHandedOff` is what tells the two apart.
    expect(tracedEnqueue(false).enqueueMs).toBe(300);
    expect(tracedEnqueue(true).enqueueMs).toBe(300);
    expect(tracedEnqueue(true).queueMessages).toBe(4);
  });

  it("flattens the trace and the caller's fields into one record", () => {
    const r = buildSlowRequest(slowTrace(1500), {
      route: "/v1/logs",
      format: "otlp-logs",
      status: 200,
      ingestSource: "example-app",
      colo: "LHR",
    });
    expect(r).toMatchObject({
      route: "/v1/logs",
      format: "otlp-logs",
      status: 200,
      totalMs: 1500,
      authMs: 1500,
      readMs: 0,
      enqueueMs: 0,
      bodyBytes: 812,
      queueMessages: 1,
      colo: "LHR",
    });
  });
});

// --- reportEnqueueFailure ---------------------------------------------------

/**
 * The loss report only exists once `QUEUE_ACK_DEADLINE_MS` is on, and it is the
 * only record that events the client was told were accepted are gone. Driven
 * directly here for the same reason `reportIfSlow` is: making a real send fail
 * after a real deadline is not something a test can do reliably.
 */
function failureHarness(vars: Record<string, string> = {}) {
  const sent: unknown[] = [];
  const env = {
    INGEST_QUEUE: {
      send: async (m: unknown) => {
        sent.push(m);
      },
    },
    KEYS_DB: undefined,
    SLOW_REQUEST_MS: "1000",
    SLOW_REQUEST_SOURCE: "log-cannon-ingest",
    ...vars,
  };
  const clock = fakeClock();
  const trace = new RequestTrace(clock.now);
  trace.bodyBytes = 141_000;
  clock.advance(250);
  trace.enqueued(3, true);

  const ingest = {
    request: new Request("https://logs.example.com/ingest/clef", {
      method: "POST",
      headers: { "cf-ray": "ray-abc" },
    }),
    env,
    ctx: {
      waitUntil: () => {},
      passThroughOnException: () => {},
    },
    trace,
    route: "/ingest/clef",
    source: "example-app",
  } as unknown as IngestRequest;

  return {
    sent,
    report: (error: unknown = new Error("queue unavailable")) =>
      reportEnqueueFailure(ingest, "clef", 3, error),
  };
}

describe("reportEnqueueFailure", () => {
  beforeEach(() => __resetTelemetryThrottle());

  it("logs and enqueues one event naming what was lost", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = failureHarness();
    await h.report();

    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged.event).toBe("ingest-enqueue-failed-after-response");
    expect(logged.route).toBe("/ingest/clef");
    expect(logged.ingestSource).toBe("example-app");
    expect(logged.queueMessages).toBe(3);
    expect(logged.waitedMs).toBe(250);
    expect(logged.bodyBytes).toBe(141_000);
    expect(logged.error).toBe("queue unavailable");
    expect(logged.rayId).toBe("ray-abc");
    error.mockRestore();

    expect(h.sent).toHaveLength(1);
    const msg = h.sent[0] as { format: string; source: string; body: string };
    expect(msg.source).toBe("log-cannon-ingest");
    const event = JSON.parse(atob(msg.body));
    expect(event["@l"]).toBe("Error");
    expect(event.QueueMessages).toBe(3);
    expect(event.IngestSource).toBe("example-app");
  });

  it("reports whatever the latency threshold is set to — a loss is not a latency event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = failureHarness({ SLOW_REQUEST_MS: "0" });
    await h.report();
    expect(error).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
    error.mockRestore();
  });

  it("still logs when SLOW_REQUEST_SOURCE is empty, but enqueues nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = failureHarness({ SLOW_REQUEST_SOURCE: "" });
    await h.report();
    expect(error).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(0);
    error.mockRestore();
  });

  it("never throws when the report's own send fails — the queue is what broke", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ingest = {
      request: new Request("https://logs.example.com/ingest/clef", {
        method: "POST",
      }),
      env: {
        INGEST_QUEUE: {
          send: async () => {
            throw new Error("queue unavailable");
          },
        },
        SLOW_REQUEST_SOURCE: "log-cannon-ingest",
      },
      ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
      trace: new RequestTrace(fakeClock().now),
      route: "/ingest/clef",
      source: "example-app",
    } as unknown as IngestRequest;

    await expect(
      reportEnqueueFailure(ingest, "clef", 1, new Error("original")),
    ).resolves.toBeUndefined();

    // The console line is the channel that survives a broken queue, and it
    // already carried the original loss before the report send was attempted.
    expect(
      JSON.parse(error.mock.calls[0][0] as string).error,
    ).toBe("original");
    expect(
      warn.mock.calls.map((c) => JSON.parse(c[0] as string).event),
    ).toContain("slow-ingest-report-failed");
    error.mockRestore();
    warn.mockRestore();
  });
});
