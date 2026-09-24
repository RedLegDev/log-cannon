import { describe, expect, it, vi } from "vitest";
import { resolveQueueAckDeadlineMs, sendWithDeadline } from "../src/enqueue";

/**
 * The deadline path cannot be exercised through `SELF.fetch`: the test queue
 * acks instantly and the Worker reads `QUEUE_ACK_DEADLINE_MS` from
 * `wrangler.toml`, where it is `0`. These drive `sendWithDeadline` directly
 * with a send that is genuinely slow — `scheduler.wait` is real I/O, so
 * Cloudflare's clock actually advances across it and the race resolves the way
 * it would in production rather than by timer luck.
 */

/** A real `ExecutionContext` is not needed — only that promises are collected. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, pending, settle: () => Promise.all(pending) };
}

describe("resolveQueueAckDeadlineMs", () => {
  it("takes a numeric string, which is how wrangler vars arrive", () => {
    expect(resolveQueueAckDeadlineMs("250")).toBe(250);
  });

  it("takes a number", () => {
    expect(resolveQueueAckDeadlineMs(250)).toBe(250);
  });

  it("falls back to off, never to some deadline, when unset or unparseable", () => {
    for (const raw of [undefined, null, "", "nonsense", NaN, -1, "0"]) {
      expect(resolveQueueAckDeadlineMs(raw)).toBe(0);
    }
  });
});

describe("sendWithDeadline with the deadline off", () => {
  it("awaits the send in full and never hands off", async () => {
    const h = fakeCtx();
    const onFailure = vi.fn();
    let done = false;

    const outcome = await sendWithDeadline(
      async () => {
        await scheduler.wait(40);
        done = true;
      },
      0,
      h.ctx,
      onFailure,
    );

    expect(done).toBe(true);
    expect(outcome.handedOff).toBe(false);
    expect(h.pending).toHaveLength(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("propagates a failure to the caller instead of reporting it", async () => {
    const h = fakeCtx();
    const onFailure = vi.fn();

    await expect(
      sendWithDeadline(
        async () => {
          throw new Error("queue unavailable");
        },
        0,
        h.ctx,
        onFailure,
      ),
    ).rejects.toThrow("queue unavailable");

    // The caller still owns the failure at the default, so the request 500s
    // exactly as it did before the deadline existed.
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("sendWithDeadline with a deadline set", () => {
  it("behaves exactly as an un-raced await when the send acks in time", async () => {
    const h = fakeCtx();
    const onFailure = vi.fn();

    const outcome = await sendWithDeadline(
      async () => {
        await scheduler.wait(5);
      },
      5_000,
      h.ctx,
      onFailure,
    );

    expect(outcome.handedOff).toBe(false);
    expect(h.pending).toHaveLength(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("still throws to the caller when the send fails before the deadline", async () => {
    const h = fakeCtx();
    const onFailure = vi.fn();

    await expect(
      sendWithDeadline(
        async () => {
          await scheduler.wait(5);
          throw new Error("queue unavailable");
        },
        5_000,
        h.ctx,
        onFailure,
      ),
    ).rejects.toThrow("queue unavailable");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("returns at the deadline and finishes the send in waitUntil", async () => {
    const h = fakeCtx();
    let done = false;

    const outcome = await sendWithDeadline(
      async () => {
        await scheduler.wait(200);
        done = true;
      },
      20,
      h.ctx,
      vi.fn(),
    );

    expect(outcome.handedOff).toBe(true);
    // The response would already be on its way here, with the send unfinished.
    expect(done).toBe(false);
    expect(h.pending).toHaveLength(1);

    await h.settle();
    expect(done).toBe(true);
  });

  it("reports a failure that lands after the handoff", async () => {
    const h = fakeCtx();
    const onFailure = vi.fn();

    const outcome = await sendWithDeadline(
      async () => {
        await scheduler.wait(200);
        throw new Error("queue unavailable");
      },
      20,
      h.ctx,
      onFailure,
    );

    expect(outcome.handedOff).toBe(true);
    expect(onFailure).not.toHaveBeenCalled(); // nothing known yet at response time

    await h.settle();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect((onFailure.mock.calls[0][0] as Error).message).toBe(
      "queue unavailable",
    );
  });

  it("waits for an async failure report, so the isolate is not killed mid-report", async () => {
    const h = fakeCtx();
    let reported = false;

    await sendWithDeadline(
      async () => {
        await scheduler.wait(100);
        throw new Error("queue unavailable");
      },
      20,
      h.ctx,
      async () => {
        await scheduler.wait(20);
        reported = true;
      },
    );

    await h.settle();
    expect(reported).toBe(true);
  });

  it("sends the remaining chunks when the handoff lands mid-sequence", async () => {
    // Stands in for sendChunksBatched: several awaited batches behind one
    // promise. The deadline fires after the first, which is the case that
    // would silently drop chunks if the handoff restarted or abandoned the
    // send instead of carrying the in-flight promise.
    const h = fakeCtx();
    const sent: number[] = [];

    const outcome = await sendWithDeadline(
      async () => {
        for (const batch of [1, 2, 3]) {
          await scheduler.wait(40);
          sent.push(batch);
        }
      },
      60,
      h.ctx,
      vi.fn(),
    );

    expect(outcome.handedOff).toBe(true);
    expect(sent).toEqual([1]);

    await h.settle();
    expect(sent).toEqual([1, 2, 3]);
  });

  it("runs the send exactly once whichever side of the deadline it lands", async () => {
    const h = fakeCtx();
    let calls = 0;
    const send = async () => {
      calls++;
      await scheduler.wait(200);
    };

    await sendWithDeadline(send, 20, h.ctx, vi.fn());
    await h.settle();
    expect(calls).toBe(1);
  });
});
