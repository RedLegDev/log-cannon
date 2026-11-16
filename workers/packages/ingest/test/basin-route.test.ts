// End-to-end in workerd: Basin is the only write (refs #169, #171). The copy
// must be registered before the handler returns and start only after it has
// resolved its response, and must not touch LOGS while BASIN_WRITE is off.
// Removing the scheduler.wait(0) in copyToBasin fails the first two cases.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { sendTelemetry } from "../src/index";
import { SPILL_PREFIX, copyTiming, gunzipRows } from "../src/basin";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

function body(n: number, pad = 2000) {
  let s = "";
  for (let i = 0; i < n; i++) s += JSON.stringify({ "@t": "2026-01-01T00:00:00Z", "@mt": "m {N}", N: i, Pad: "p".repeat(pad) }) + "\n";
  return s;
}
const req = (b: string) => new Request("https://logs.example.com/ingest/clef", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" }, body: b });

function rowsStream() {
  const rows: any[] = [];
  return { rows, LOGS: { send: async (r: any[]) => void rows.push(...r) } };
}

async function takeSpilled() {
  const listed = await env.BASIN_SPILL.list({ prefix: SPILL_PREFIX });
  const rows = (await Promise.all(listed.objects.map(async (o) => gunzipRows((await env.BASIN_SPILL.get(o.key))!.body)))).flat();
  for (const o of listed.objects) await env.BASIN_SPILL.delete(o.key);
  return rows;
}

// SLOW_REQUEST_SOURCE off: the test config reports every request as slow, and
// that report's own one-line Basin copy is not the request's copy.
const base = { BASIN_WRITE: "true", SLOW_REQUEST_SOURCE: "" };

describe("Basin write through the fetch handler", () => {
  beforeEach(async () => {
    __resetKeyCache(); __resetTelemetryThrottle();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await env.KEYS_DB.prepare(`INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES ('k-good','id-k-good','example-app',1,'ingest',0,'2026-01-01T00:00:00Z')`).run();
  });
  afterEach(() => vi.restoreAllMocks());

  // 5 rows is the single-chunk path; 2000 × 2 KB is past the 90 KB chunk size.
  for (const n of [5, 2000]) it(`response resolves before any row is built (n=${n})`, async () => {
    const order: string[] = [];
    const orig = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(function (this: unknown, v: any, ...a: any[]) {
      if (v && typeof v === "object" && !Array.isArray(v) && "key_id" in v && order.at(-1) !== "row") order.push("row");
      return (orig as any).call(JSON, v, ...a);
    } as any);
    const sent: any[][] = [];
    const LOGS = { send: async (r: any[]) => { order.push("send"); await scheduler.wait(1); sent.push(r); } };
    const ctx = createExecutionContext();
    const p = worker.fetch(req(body(n)), { ...env, ...base, LOGS } as never, ctx);
    const res = await p;
    order.push("response");
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();
    expect(order[0]).toBe("response");
    const ns = sent.flat().map((r) => r.properties.N);
    expect(ns).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  // refs #175: a client that disconnects ends the invocation at the next await,
  // so the copy has to be registered by the time the handler answers.
  it("answers with the copy already registered and not yet run", async () => {
    const { rows, LOGS } = rowsStream();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} };
    const res = await worker.fetch(req(body(3, 0)), { ...env, ...base, LOGS } as never, ctx as never);
    expect(res.status).toBe(201);
    expect(pending).toHaveLength(1);
    expect(rows).toHaveLength(0);
    await Promise.all(pending);
    expect(rows.map((r) => r.properties.N)).toEqual([0, 1, 2]);
  });

  it("the Worker's own telemetry reaches Basin, as key log-cannon-ingest", async () => {
    const { rows, LOGS } = rowsStream();
    const line = JSON.stringify({ "@t": "2026-10-23T15:00:00Z", "@l": "Warning", "@mt": "slow {Route}", Route: "/ingest/clef" });
    await sendTelemetry({ ...env, LOGS, BASIN_WRITE: "true" } as never, "log-cannon-ingest", [line]);
    expect(rows).toEqual([expect.objectContaining({ source: "log-cannon-ingest", key_id: "log-cannon-ingest", level: "Warning" })]);
    rows.length = 0;
    await sendTelemetry({ ...env, LOGS, BASIN_WRITE: "false" } as never, "log-cannon-ingest", [line]);
    expect(rows).toHaveLength(0);
  });

  it("flag off: LOGS untouched", async () => {
    let calls = 0;
    const LOGS = { send: async () => { calls++; } };
    const ctx = createExecutionContext();
    const res = await worker.fetch(req(body(3)), { ...env, LOGS, BASIN_WRITE: "false" } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201); expect(calls).toBe(0);
  });

  describe("stream down", () => {
    const real = { sleep: copyTiming.sleep, spill: copyTiming.spillTimeoutMs, telemetry: copyTiming.telemetrySpillTimeoutMs };
    beforeEach(() => void (copyTiming.sleep = async () => {}));
    afterEach(() => {
      copyTiming.sleep = real.sleep;
      copyTiming.spillTimeoutMs = real.spill;
      copyTiming.telemetrySpillTimeoutMs = real.telemetry;
    });
    const down = { send: async () => { throw new Error("stream unavailable"); } };
    /** A spill bucket whose puts take 100 ms. */
    const slowSpill = {
      put: async (k: string, v: Blob, o?: R2PutOptions) => {
        await new Promise((r) => setTimeout(r, 100));
        return env.BASIN_SPILL.put(k, v, o);
      },
    };

    it("spills the request's rows instead", async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(req(body(3, 0)), { ...env, ...base, LOGS: down } as never, ctx);
      expect(res.status).toBe(201);
      await waitOnExecutionContext(ctx);
      expect((await takeSpilled()).map((r) => r.properties.N)).toEqual([0, 1, 2]);
    });

    // The request copy's spill runs on spillTimeoutMs, the telemetry's on the
    // shorter telemetrySpillTimeoutMs (refs #166).
    it("a request copy's slow spill put is held to spillTimeoutMs, not the telemetry limit", async () => {
      copyTiming.spillTimeoutMs = 2_000;
      copyTiming.telemetrySpillTimeoutMs = 10;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = createExecutionContext();
      const res = await worker.fetch(req(body(3, 0)), { ...env, ...base, LOGS: down, BASIN_SPILL: slowSpill } as never, ctx);
      expect(res.status).toBe(201);
      await waitOnExecutionContext(ctx);
      await takeSpilled();
      const failed = JSON.parse(logged.mock.calls.map((c) => String(c[0])).find((e) => e.includes("basin-copy-failed"))!);
      expect(failed.spilledRows).toBe(3);
    });

    it("sendTelemetry's slow spill put is cut at telemetrySpillTimeoutMs", async () => {
      copyTiming.spillTimeoutMs = 2_000;
      copyTiming.telemetrySpillTimeoutMs = 10;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const line = JSON.stringify({ "@t": "2026-10-23T15:00:00Z", "@l": "Warning", "@mt": "slow {Route}", Route: "/ingest/clef" });
      await sendTelemetry({ ...env, LOGS: down, BASIN_WRITE: "true", BASIN_SPILL: slowSpill } as never, "log-cannon-ingest", [line]);
      // Let the put abandoned by the 10 ms limit finish before reading the bucket.
      await new Promise((r) => setTimeout(r, 150));
      await takeSpilled();
      const failed = JSON.parse(logged.mock.calls.map((c) => String(c[0])).find((e) => e.includes("telemetry-basin-copy-failed"))!);
      expect(failed).toMatchObject({ spilledRows: 0, lostRows: 1, spillError: "spill timed out after 10 ms" });
    });
  });
});
