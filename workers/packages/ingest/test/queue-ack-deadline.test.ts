import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { __resetKeyCache } from "../src/keys";
import { __resetTelemetryThrottle } from "../src/timing";

/**
 * The deadline armed, end to end through the router.
 *
 * `SELF.fetch` cannot be used for this: it goes to the deployed test worker,
 * whose `QUEUE_ACK_DEADLINE_MS` comes from `wrangler.toml` (`0`) and whose
 * queue acks instantly. Calling `worker.fetch` directly lets the env carry a
 * queue that is genuinely slow — `scheduler.wait` is real I/O, so Cloudflare's
 * clock advances across it — and the deadline that the shipped default keeps
 * switched off.
 */

const CLEF_LINE = `${JSON.stringify({
  "@t": "2026-01-01T00:00:00Z",
  "@mt": "hello",
})}\n`;

/** A body over MAX_QUEUE_CHUNK_BYTES (90 KB), so the request takes the chunked path. */
function chunkedCLEFBody(): string {
  const line = `${JSON.stringify({
    "@t": "2026-01-01T00:00:00Z",
    "@mt": "x".repeat(30_000),
  })}\n`;
  return line.repeat(8); // ~240 KB raw -> 3 chunks
}

/**
 * A queue whose acks take `ackMs`, optionally failing after that.
 *
 * `ingest()` filters out the worker's own slow-request telemetry, which shares
 * this binding (`SLOW_REQUEST_SOURCE` in `wrangler.toml`) and would otherwise
 * be counted as payload.
 */
function slowQueue(ackMs: number, fail = false) {
  const sent: Array<{ source: string }> = [];
  const batched: Array<Array<{ body: { source: string } }>> = [];
  return {
    sent,
    batched,
    ingest: () => sent.filter((m) => m.source === "example-app"),
    ingestBatched: () =>
      batched.flat().filter((m) => m.body.source === "example-app"),
    binding: {
      async send(message: { source: string }) {
        await scheduler.wait(ackMs);
        if (fail) throw new Error("queue unavailable");
        sent.push(message);
      },
      async sendBatch(messages: Array<{ body: { source: string } }>) {
        await scheduler.wait(ackMs);
        if (fail) throw new Error("queue unavailable");
        batched.push(messages);
      },
    },
  };
}

function clefRequest(body: string): Request {
  return new Request("https://logs.example.com/ingest/clef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": "k-good" },
    body,
  });
}

/** The worker's structured lines, by `event` name, out of a console spy. */
function events(spy: ReturnType<typeof vi.spyOn>, name: string) {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    })
    .filter((e) => e?.event === name);
}

describe("QUEUE_ACK_DEADLINE_MS through the router", () => {
  beforeEach(async () => {
    __resetKeyCache();
    __resetTelemetryThrottle();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await env.KEYS_DB.prepare(
      `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
       VALUES ('k-good', 'id-k-good', 'example-app', 1, 'ingest', 0, '2026-01-01T00:00:00Z')`,
    ).run();
  });

  it("waits for the ack in full when the deadline is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = slowQueue(80);
    const ctx = createExecutionContext();

    const res = await worker.fetch(
      clefRequest(CLEF_LINE),
      { ...env, INGEST_QUEUE: q.binding, QUEUE_ACK_DEADLINE_MS: "0" } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(201);
    // Already enqueued by the time the response was produced.
    expect(q.ingest()).toHaveLength(1);

    const [report] = events(warn, "slow-ingest-request");
    expect(report.enqueueMs).toBeGreaterThanOrEqual(80);
    expect("enqueueHandedOff" in report).toBe(false);
    warn.mockRestore();
  });

  it("returns the normal success response at the deadline and finishes the send after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = slowQueue(400);
    const ctx = createExecutionContext();

    const res = await worker.fetch(
      clefRequest(CLEF_LINE),
      { ...env, INGEST_QUEUE: q.binding, QUEUE_ACK_DEADLINE_MS: "40" } as never,
      ctx,
    );

    // Same status and body as an un-raced request — the client cannot tell.
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ MinimumLevelAccepted: null });
    expect(q.ingest()).toHaveLength(0); // the ack had not arrived yet

    await waitOnExecutionContext(ctx);
    expect(q.ingest()).toHaveLength(1); // ...and it still completed

    const [report] = events(warn, "slow-ingest-request");
    expect(report.enqueueHandedOff).toBe(true);
    // EnqueueMs is the caller's wait, so it stops at the deadline rather than
    // running on to the queue's 400 ms.
    expect(report.enqueueMs).toBeLessThan(400);
    warn.mockRestore();
  });

  it("sends every chunk of a chunked body when the deadline lands mid-sequence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = slowQueue(120);
    const ctx = createExecutionContext();

    const res = await worker.fetch(
      clefRequest(chunkedCLEFBody()),
      { ...env, INGEST_QUEUE: q.binding, QUEUE_ACK_DEADLINE_MS: "40" } as never,
      ctx,
    );
    expect(res.status).toBe(201);

    const [report] = events(warn, "slow-ingest-request");
    expect(report.enqueueHandedOff).toBe(true);
    expect(report.queueMessages).toBeGreaterThan(1);

    await waitOnExecutionContext(ctx);
    expect(q.ingestBatched()).toHaveLength(report.queueMessages);
    warn.mockRestore();
  });

  it("reports a send that fails after the response as its own event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = slowQueue(200, true);
    const ctx = createExecutionContext();

    const res = await worker.fetch(
      clefRequest(CLEF_LINE),
      { ...env, INGEST_QUEUE: q.binding, QUEUE_ACK_DEADLINE_MS: "40" } as never,
      ctx,
    );
    // The client was told its events were accepted, which is exactly why the
    // loss has to be recorded somewhere.
    expect(res.status).toBe(201);

    await waitOnExecutionContext(ctx);

    const [loss] = events(error, "ingest-enqueue-failed-after-response");
    expect(loss).toBeDefined();
    expect(loss.route).toBe("/ingest/clef");
    expect(loss.ingestSource).toBe("example-app");
    expect(loss.queueMessages).toBe(1);
    expect(loss.error).toBe("queue unavailable");
    // Distinct from the latency event, so the two can be alerted on apart.
    expect(events(warn, "slow-ingest-request")).toHaveLength(1);
    error.mockRestore();
    warn.mockRestore();
  });

  it("still fails the request when the send fails before the deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = slowQueue(10, true);
    const ctx = createExecutionContext();

    // Before the deadline the caller owns the failure, deadline or not — an
    // unhandled throw the router turns into a 5xx a Seq sink will retry.
    await expect(
      worker.fetch(
        clefRequest(CLEF_LINE),
        {
          ...env,
          INGEST_QUEUE: q.binding,
          QUEUE_ACK_DEADLINE_MS: "5000",
        } as never,
        ctx,
      ),
    ).rejects.toThrow("queue unavailable");

    await waitOnExecutionContext(ctx);
    warn.mockRestore();
  });
});
