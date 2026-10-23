// End-to-end in workerd: the copy must start only after the handler has
// resolved its response, and must not touch LOGS while BASIN_WRITE is off.
// Removing the scheduler.wait(0) in copyToBasin fails the first two cases.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

function body(n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += JSON.stringify({ "@t": "2026-01-01T00:00:00Z", "@mt": "m {N}", N: i, Pad: "p".repeat(2000) }) + "\n";
  return s;
}
const req = (b: string) => new Request("https://logs.example.com/ingest/clef", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" }, body: b });

describe("Basin dual-write through the fetch handler", () => {
  beforeEach(async () => {
    __resetKeyCache(); __resetTelemetryThrottle();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await env.KEYS_DB.prepare(`INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES ('k-good','id-k-good','example-app',1,'ingest',0,'2026-01-01T00:00:00Z')`).run();
  });

  for (const n of [5, 2000]) it(`response resolves before any row is built (n=${n})`, async () => {
    const order: string[] = [];
    const orig = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(function (this: unknown, v: any, ...a: any[]) {
      if (v && typeof v === "object" && !Array.isArray(v) && "key_id" in v && order.at(-1) !== "row") order.push("row");
      return (orig as any).call(JSON, v, ...a);
    } as any);
    const sent: any[][] = [];
    const LOGS = { send: async (r: any[]) => { order.push("send"); await scheduler.wait(1); sent.push(r); } };
    const queue = { send: async () => {}, sendBatch: async () => {} };
    const ctx = createExecutionContext();
    const p = worker.fetch(req(body(n)), { ...env, INGEST_QUEUE: queue, LOGS, BASIN_WRITE: "true", QUEUE_ACK_DEADLINE_MS: "0" } as never, ctx);
    const res = await p;
    order.push("response");
    expect(res.status).toBe(201);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();
    expect(order[0]).toBe("response");
    const ns = sent.flat().map((r) => r.properties.N);
    expect(ns).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it("flag off: LOGS untouched", async () => {
    let calls = 0;
    const LOGS = { send: async () => { calls++; } };
    const ctx = createExecutionContext();
    const res = await worker.fetch(req(body(3)), { ...env, INGEST_QUEUE: { send: async () => {}, sendBatch: async () => {} }, LOGS, BASIN_WRITE: "false" } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201); expect(calls).toBe(0);
  });
});
