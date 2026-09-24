/**
 * Bounding how long the caller waits for a queue acknowledgement.
 *
 * Why this exists: `env.INGEST_QUEUE.send(...)` is a durable-ack round trip, so
 * whatever Cloudflare Queues takes to acknowledge is time the client spends
 * waiting for its ingest response. #107's instrumentation measured that tail on
 * an idle, healthy queue — 676 requests over 1 s in 95 minutes, a worst
 * `EnqueueMs` of 64 s, with ~0 of it in auth or read. No sender ceiling can be
 * made safe against that: senders bound their own fetch (Serilog's Seq sink and
 * most hand-rolled clients at 5 s), abort, and the events are lost from the
 * client's point of view while the platform is healthy.
 *
 * So the wait gets a deadline. If the ack arrives in time, nothing changes. If
 * the deadline passes first, the *same in-flight send* is handed to
 * `ctx.waitUntil` and the caller gets its normal success response immediately.
 * Handing off the in-flight promise rather than starting a new send is what
 * makes the chunked path safe: `sendChunksBatched` awaits several `sendBatch`
 * calls, and the promise being handed off is the whole sequence, so the batches
 * that had not gone out yet still go out. The deadline bounds the *caller's*
 * wait, never the send.
 *
 * **This ships off.** A handoff means the Worker has answered 201 before the
 * queue has durably accepted the payload, which is a real change to delivery
 * semantics on a log platform: a send that fails after the response is a loss
 * the client already believes succeeded. `QUEUE_ACK_DEADLINE_MS` therefore
 * defaults to `0`, which is exactly today's behaviour — await the send fully,
 * no race, no timer, and a failure still surfaces to the caller.
 */

/** Resolved when the deadline fires rather than when the send finishes. */
const DEADLINE_REACHED = Symbol("queue-ack-deadline");

/** A send that has settled, with its rejection captured rather than thrown. */
type SendResult = { ok: true } | { ok: false; error: unknown };

/** What the caller needs to know about how the enqueue ended. */
export interface EnqueueOutcome {
  /**
   * True when the deadline fired first and the rest of the send was handed to
   * `waitUntil`. The response was returned without the ack.
   */
  handedOff: boolean;
}

/**
 * Deadline in milliseconds from the `QUEUE_ACK_DEADLINE_MS` var. `0` — the
 * default, and the value anything unset or unparseable falls back to — means
 * await the send fully, the behaviour that predates this module. Falling back
 * to off rather than to some default deadline is deliberate: a typo in the var
 * must not quietly start answering before the queue has the payload.
 */
export function resolveQueueAckDeadlineMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** A cancellable timer, so a send that wins the race leaves nothing pending. */
function deadlineTimer(ms: number): {
  promise: Promise<typeof DEADLINE_REACHED>;
  cancel: () => void;
} {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    id = setTimeout(() => resolve(DEADLINE_REACHED), ms);
  });
  return {
    promise,
    cancel: () => {
      if (id !== undefined) clearTimeout(id);
    },
  };
}

/**
 * Run `send` with the caller's wait bounded by `deadlineMs`.
 *
 * - `deadlineMs <= 0`: awaits `send()` and nothing else. A rejection propagates
 *   to the caller exactly as an un-raced `await` would, and `onFailure` is
 *   never reached — the caller still owns the failure.
 * - Send wins: same as above, plus the timer is cancelled.
 * - Deadline wins: the in-flight send goes to `ctx.waitUntil`, and a rejection
 *   that lands *after* the response is routed to `onFailure`. That callback is
 *   the only place such a failure can ever be observed, which is why the caller
 *   must make it report rather than swallow.
 *
 * `send` is a thunk so the promise is created here and every path holds the
 * same handle to it — there is never a second send. Whatever it resolves to is
 * discarded; only whether it settled before the deadline matters.
 */
export async function sendWithDeadline(
  send: () => Promise<unknown>,
  deadlineMs: number,
  ctx: ExecutionContext,
  onFailure: (error: unknown) => void | Promise<void>,
): Promise<EnqueueOutcome> {
  if (deadlineMs <= 0) {
    await send();
    return { handedOff: false };
  }

  // Capture the rejection instead of letting it escape: after a handoff the
  // race's promise is no longer awaited by anyone, and a rejection with no
  // handler attached is an unhandled rejection in the isolate.
  const settled: Promise<SendResult> = send().then(
    (): SendResult => ({ ok: true }),
    (error: unknown): SendResult => ({ ok: false, error }),
  );

  const timer = deadlineTimer(deadlineMs);
  const first = await Promise.race([settled, timer.promise]);
  timer.cancel();

  if (first === DEADLINE_REACHED) {
    ctx.waitUntil(
      settled.then((r) => {
        // Returned, not fired and forgotten: `onFailure` reports the loss and
        // may itself need I/O, and this `waitUntil` is what keeps the isolate
        // alive long enough for it.
        if (!r.ok) return onFailure(r.error);
      }),
    );
    return { handedOff: true };
  }

  if (!first.ok) throw first.error;
  return { handedOff: false };
}
