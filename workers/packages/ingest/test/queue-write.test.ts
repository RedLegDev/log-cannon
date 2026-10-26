// QUEUE_WRITE (refs #169): "false" makes the Basin copy the only write. The
// queue mocks record every call, so a request path that still sends to the
// queue while the switch is off fails these tests.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { sendTelemetry } from "../src/index";
import { SPILL_PREFIX, copyTiming, gunzipRows } from "../src/basin";
import { queueWriteEnabled } from "../src/enqueue";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

function body(n: number, pad = 0) {
  let s = "";
  for (let i = 0; i < n; i++) s += JSON.stringify({ "@t": "2026-01-01T00:00:00Z", "@mt": "m {N}", N: i, Pad: "p".repeat(pad) }) + "\n";
  return s;
}
const req = (b: string) =>
  new Request("https://logs.example.com/ingest/clef", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" }, body: b });

/** A queue that records every call, and can be told to fail. */
function recordingQueue(fail = false) {
  const calls: string[] = [];
  const op = (name: string) => async () => {
    calls.push(name);
    if (fail) throw new Error("queue unavailable");
  };
  return { calls, queue: { send: op("send"), sendBatch: op("sendBatch") } };
}

function rowsStream() {
  const rows: any[] = [];
  return { rows, LOGS: { send: async (r: any[]) => void rows.push(...r) } };
}

// SLOW_REQUEST_SOURCE off: the test config reports every request as slow, and
// that report's own copy is not the request's.
const base = { BASIN_WRITE: "true", QUEUE_ACK_DEADLINE_MS: "0", SLOW_REQUEST_SOURCE: "" };

beforeEach(async () => {
  __resetKeyCache();
  __resetTelemetryThrottle();
  await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  await env.KEYS_DB.prepare(
    `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES ('k-good','id-k-good','example-app',1,'ingest',0,'2026-01-01T00:00:00Z')`,
  ).run();
});
afterEach(() => vi.restoreAllMocks());

describe("queueWriteEnabled", () => {
  it("is off only for exactly false, and only while Basin is writing", () => {
    expect(queueWriteEnabled("false", true)).toBe(false);
    expect(queueWriteEnabled(" false ", true)).toBe(false);
    for (const v of [undefined, "", "true", "False", "0", "no"]) expect(queueWriteEnabled(v, true)).toBe(true);
    expect(queueWriteEnabled("false", false)).toBe(true);
  });
});

describe("QUEUE_WRITE=false through the fetch handler", () => {
  // 5 rows is the single-message path; 200 × 2 KB is past the 90 KB chunk
  // size, the sendChunksBatched path.
  for (const [n, pad] of [[5, 0], [200, 2000]]) it(`no queue call, every row reaches the stream (n=${n})`, async () => {
    const { calls, queue } = recordingQueue();
    const { rows, LOGS } = rowsStream();
    const ctx = createExecutionContext();
    const res = await worker.fetch(req(body(n, pad)), { ...env, ...base, INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "false" } as never, ctx);
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual([]);
    expect(rows.map((r) => r.properties.N)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it("answers before the copy runs, with the copy already registered", async () => {
    const { calls, queue } = recordingQueue();
    const { rows, LOGS } = rowsStream();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} };
    const res = await worker.fetch(req(body(3)), { ...env, ...base, INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "false" } as never, ctx as never);
    expect(res.status).toBe(201);
    expect(pending).toHaveLength(1);
    expect(rows).toHaveLength(0);
    await Promise.all(pending);
    expect(rows.map((r) => r.properties.N)).toEqual([0, 1, 2]);
    expect(calls).toEqual([]);
  });

  describe("stream down", () => {
    const realSleep = copyTiming.sleep;
    beforeEach(() => void (copyTiming.sleep = async () => {}));
    afterEach(() => void (copyTiming.sleep = realSleep));

    it("spills the rows instead", async () => {
      const { calls, queue } = recordingQueue();
      const LOGS = { send: async () => { throw new Error("stream unavailable"); } };
      const ctx = createExecutionContext();
      const res = await worker.fetch(req(body(3)), { ...env, ...base, INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "false" } as never, ctx);
      expect(res.status).toBe(201);
      await waitOnExecutionContext(ctx);
      expect(calls).toEqual([]);
      const listed = await env.BASIN_SPILL.list({ prefix: SPILL_PREFIX });
      const spilled = (await Promise.all(listed.objects.map(async (o) => gunzipRows((await env.BASIN_SPILL.get(o.key))!.body)))).flat();
      for (const o of listed.objects) await env.BASIN_SPILL.delete(o.key);
      expect(spilled.map((r) => r.properties.N)).toEqual([0, 1, 2]);
    });
  });

  it("reports no enqueue loss, even with the ack deadline on and a failing queue", async () => {
    const { calls, queue } = recordingQueue(true);
    const { rows, LOGS } = rowsStream();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      req(body(3)),
      { ...env, ...base, QUEUE_ACK_DEADLINE_MS: "1", SLOW_REQUEST_SOURCE: "log-cannon-ingest", INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "false" } as never,
      ctx,
    );
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual([]);
    expect(errors.filter((e) => e.includes("enqueue-failed"))).toEqual([]);
    expect(rows.filter((r) => r.source === "example-app")).toHaveLength(3);
  });

  it("keeps writing the queue when BASIN_WRITE is off, so nothing is dropped", async () => {
    const { calls, queue } = recordingQueue();
    const { rows, LOGS } = rowsStream();
    const ctx = createExecutionContext();
    const res = await worker.fetch(req(body(3)), { ...env, ...base, BASIN_WRITE: "false", INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "false" } as never, ctx);
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual(["send"]);
    expect(rows).toHaveLength(0);
  });
});

describe("QUEUE_WRITE=true (and unset) through the fetch handler", () => {
  for (const flag of ["true", undefined]) it(`queue then Basin, as before (QUEUE_WRITE=${flag})`, async () => {
    const { calls, queue } = recordingQueue();
    const { rows, LOGS } = rowsStream();
    const ctx = createExecutionContext();
    const res = await worker.fetch(req(body(3)), { ...env, ...base, INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: flag } as never, ctx);
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual(["send"]);
    expect(rows.map((r) => r.properties.N)).toEqual([0, 1, 2]);
  });

  it("a refused enqueue still fails the request and copies nothing", async () => {
    const { calls, queue } = recordingQueue(true);
    const { rows, LOGS } = rowsStream();
    const ctx = createExecutionContext();
    await expect(
      worker.fetch(req(body(3)), { ...env, ...base, INGEST_QUEUE: queue, LOGS, QUEUE_WRITE: "true" } as never, ctx),
    ).rejects.toThrow("queue unavailable");
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual(["send"]);
    expect(rows).toHaveLength(0);
  });
});

describe("sendTelemetry follows QUEUE_WRITE", () => {
  const line = JSON.stringify({ "@t": "2026-10-23T15:00:00Z", "@l": "Warning", "@mt": "slow {Route}", Route: "/ingest/clef" });

  it("false: Basin only, and a broken queue can't make it throw", async () => {
    const { calls, queue } = recordingQueue(true);
    const { rows, LOGS } = rowsStream();
    await sendTelemetry({ ...env, INGEST_QUEUE: queue, LOGS, BASIN_WRITE: "true", QUEUE_WRITE: "false" } as never, "log-cannon-ingest", [line]);
    expect(calls).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ source: "log-cannon-ingest", key_id: "log-cannon-ingest" })]);
  });

  it("true: queue and Basin", async () => {
    const { calls, queue } = recordingQueue();
    const { rows, LOGS } = rowsStream();
    await sendTelemetry({ ...env, INGEST_QUEUE: queue, LOGS, BASIN_WRITE: "true", QUEUE_WRITE: "true" } as never, "log-cannon-ingest", [line]);
    expect(calls).toEqual(["send"]);
    expect(rows).toHaveLength(1);
  });
});
