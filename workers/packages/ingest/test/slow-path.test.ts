import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

/**
 * A request body that takes a real, measurable amount of time to read, so the
 * slow path can be exercised without waiting on a genuine stall. Cloudflare's
 * clock advances across the `scheduler.wait`, which is what makes the `read`
 * span non-zero and the assertions below deterministic rather than timing luck.
 */
function slowBody(bytes: Uint8Array, delayMs = 60): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      await scheduler.wait(delayMs);
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const CLEF_LINE = `${JSON.stringify({
  "@t": "2026-01-01T00:00:00Z",
  "@mt": "hello",
})}\n`;

/** Parse the worker's own structured slow-request warnings out of a spy. */
function slowWarnings(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    })
    .filter((e) => e?.event === "slow-ingest-request");
}

// The threshold comes from vitest.config.ts (SLOW_REQUEST_MS = "1"): the worker
// reads its vars from wrangler.toml and does not observe a test-side mutation
// of `env`. Threshold parsing, the disabled case and the throttle are covered
// as units in test/timing.test.ts.
describe("slow-request reporting through the router", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    __resetKeyCache();
    __resetTelemetryThrottle();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await env.KEYS_DB.prepare(
      `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
       VALUES ('k-good', 'id-k-good', 'example-app', 1, 'ingest', 0, '2026-01-01T00:00:00Z')`,
    ).run();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("attributes a slow body read to ReadMs on the happy path", async () => {
    const res = await SELF.fetch("https://logs.example.com/ingest/clef", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" },
      body: slowBody(new TextEncoder().encode(CLEF_LINE)),
    });
    expect(res.status).toBe(201);

    const [report] = slowWarnings(warn);
    expect(report).toBeDefined();
    expect(report.route).toBe("/ingest/clef");
    expect(report.format).toBe("clef");
    expect(report.status).toBe(201);
    expect(report.ingestSource).toBe("example-app");
    expect(report.readMs).toBeGreaterThan(0);
    expect(report.totalMs).toBeGreaterThanOrEqual(report.readMs);
    expect(report.queueMessages).toBe(1);
    expect(report.bodyBytes).toBe(CLEF_LINE.length);
  });

  it("still attributes the read span when the body read fails", async () => {
    // gzip declared, raw JSON sent: readBody throws BadBodyError *after* the
    // stream I/O, so the handler never reaches its own mark. A report with a
    // large totalMs and an all-zero breakdown is the regression this guards.
    const res = await SELF.fetch("https://logs.example.com/ingest/clef", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "X-Api-Key": "k-good",
      },
      body: slowBody(new TextEncoder().encode(CLEF_LINE)),
    });
    expect(res.status).toBe(400);

    const [report] = slowWarnings(warn);
    expect(report).toBeDefined();
    expect(report.status).toBe(400);
    expect(report.format).toBe("clef");
    expect(report.readMs).toBeGreaterThan(0);
    expect(report.enqueueMs).toBe(0);
  });

  it("marks the key as uncached on a cold isolate and cached on the next request", async () => {
    const send = () =>
      SELF.fetch("https://logs.example.com/ingest/clef", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" },
        body: slowBody(new TextEncoder().encode(CLEF_LINE)),
      });

    await send();
    await send();

    const reports = slowWarnings(warn);
    expect(reports).toHaveLength(2);
    expect(reports[0].keyCacheHit).toBe(false);
    expect(reports[1].keyCacheHit).toBe(true);
  });
});
