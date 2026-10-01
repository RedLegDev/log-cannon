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

/** Start `send`, capturing its rejection as a `SendResult` instead of throwing. */
function toSendResult(send: () => Promise<unknown>): Promise<SendResult> {
  return send().then(
    (): SendResult => ({ ok: true }),
    (error: unknown): SendResult => ({ ok: false, error }),
  );
}

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
 * Backoff before each re-send of a payload whose handed-off send failed.
 *
 * Only the post-handoff path retries. Before the deadline a failure still goes
 * to the caller, whose 5xx makes Serilog/Seq sinks resend on their own. After
 * it, the caller has its 201 and will never resend, so a failed send here is a
 * loss unless the Worker retries it. The payload is still in memory, so it can.
 * On 2026-10-01 two events were lost this way to `Too Many Requests` from
 * Queues during one of #113's stalls (refs #143). The delays are long enough to
 * ride out a short throttle, and short enough to fit in `waitUntil`.
 *
 * Any error is retried, not just a 429: queue send errors arrive as untyped
 * message strings, and an error that will never succeed costs only these extra
 * attempts. A retry can duplicate a message, the same at-least-once caveat as
 * the rest of `logs.events`.
 */
export const HANDOFF_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

/**
 * Latest a retry may start, in milliseconds after the handoff began.
 *
 * `waitUntil` keeps the isolate alive for about 30 s after the response. If a
 * retry is still running when that runs out, the isolate is killed and the
 * loss report never happens, which is worse than reporting the loss without
 * the retry. So a retry that cannot start inside this budget is skipped, and
 * the last failure is reported straight away.
 */
const HANDOFF_RETRY_BUDGET_MS = 20_000;

type FinalResult = { ok: true } | { ok: false; error: unknown; attempts: number };

/**
 * Wait for the handed-off send. If it fails, re-run `send` after each delay
 * until one attempt succeeds, the delays run out, or the budget would be
 * overrun.
 */
async function retryAfterHandoff(
  first: Promise<SendResult>,
  send: () => Promise<unknown>,
  delaysMs: readonly number[],
): Promise<FinalResult> {
  // `Date.now()` only advances across I/O in a Worker, and every step here is
  // I/O (the send, or `scheduler.wait`), so elapsed time is real.
  const start = Date.now();
  let r = await first;
  let attempts = 1;
  for (const delay of delaysMs) {
    if (r.ok) return r;
    if (Date.now() - start + delay > HANDOFF_RETRY_BUDGET_MS) break;
    await scheduler.wait(delay);
    attempts++;
    r = await toSendResult(send);
  }
  return r.ok ? r : { ok: false, error: r.error, attempts };
}

/**
 * Run `send` with the caller's wait bounded by `deadlineMs`.
 *
 * - `deadlineMs <= 0`: awaits `send()` and nothing else. A rejection propagates
 *   to the caller exactly as an un-raced `await` would, and `onFailure` is
 *   never reached — the caller still owns the failure.
 * - Send wins: same as above, plus the timer is cancelled.
 * - Deadline wins: the in-flight send goes to `ctx.waitUntil`. If it rejects
 *   *after* the response, `send` is re-run after each of `retryDelaysMs`
 *   (see `HANDOFF_RETRY_DELAYS_MS`), and only a failure of the last attempt is
 *   routed to `onFailure`. That callback is the only place such a failure can
 *   ever be observed, which is why the caller must make it report rather than
 *   swallow.
 *
 * `send` is a thunk so the promise is created here and every path holds the
 * same handle to it — there is never a second send before the deadline, and
 * never one after a send that succeeded. Whatever it resolves to is discarded;
 * only whether it settled before the deadline matters.
 */
export async function sendWithDeadline(
  send: () => Promise<unknown>,
  deadlineMs: number,
  ctx: ExecutionContext,
  onFailure: (error: unknown, attempts: number) => void | Promise<void>,
  retryDelaysMs: readonly number[] = HANDOFF_RETRY_DELAYS_MS,
): Promise<EnqueueOutcome> {
  if (deadlineMs <= 0) {
    await send();
    return { handedOff: false };
  }

  // Capture the rejection instead of letting it escape: after a handoff the
  // race's promise is no longer awaited by anyone, and a rejection with no
  // handler attached is an unhandled rejection in the isolate.
  const settled = toSendResult(send);

  const timer = deadlineTimer(deadlineMs);
  const first = await Promise.race([settled, timer.promise]);
  timer.cancel();

  if (first === DEADLINE_REACHED) {
    ctx.waitUntil(
      // Returned, not fired and forgotten: `onFailure` reports the loss and
      // may itself need I/O, and this `waitUntil` is what keeps the isolate
      // alive long enough for it.
      retryAfterHandoff(settled, send, retryDelaysMs).then((r) => {
        if (!r.ok) return onFailure(r.error, r.attempts);
      }),
    );
    return { handedOff: true };
  }

  if (!first.ok) throw first.error;
  return { handedOff: false };
}
