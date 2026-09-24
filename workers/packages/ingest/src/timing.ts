/**
 * Per-request latency attribution for the ingest path.
 *
 * Why this exists: senders bound their outbound fetch (Serilog's Seq sink and
 * hand-rolled `AbortSignal.timeout` callers both do), so a request that stalls
 * past that bound is aborted client-side. Nothing is written, the response is
 * never read, and with no invocation logs the ingest side has no record that
 * the request happened at all — the only trace is the sender's `TimeoutError`.
 * This module makes a slow request say so, and say *where* the time went.
 *
 * **Clock caveat.** Cloudflare freezes `Date.now()` between I/O operations, so
 * these spans measure I/O, not CPU. That suits the question being asked — every
 * span below is bounded by an `await` on D1, the request body stream, or the
 * queue — but a purely CPU-bound stall reads as 0 ms here. Workers Logs
 * `cpuTime` is where that would surface instead.
 *
 * **What this cannot see.** Timing starts when the Worker is invoked, so
 * connection setup, TLS, and isolate cold start are all outside it. A sender
 * that saw 5 s against a total of 40 ms here is a real result, not a broken
 * measurement: it places the stall before the Worker rather than inside it.
 */

/** I/O spans of an ingest request, in the order they occur. */
export type Phase = "auth" | "read" | "enqueue";

/** Requests at or above this many milliseconds are reported. */
export const DEFAULT_SLOW_REQUEST_MS = 1000;

/**
 * Minimum gap between two queue-borne slow-request events, per isolate.
 *
 * The console warning is never throttled — it is free and suppressing it would
 * hide the shape of a burst. The queue event is, because the failure mode that
 * matters most is a slow `enqueue` span, and answering a struggling queue by
 * sending it more messages is how a degradation becomes an outage. One event
 * per isolate per interval is enough to see a spike and to alert on it.
 */
export const TELEMETRY_MIN_INTERVAL_MS = 10_000;

/**
 * Mutable record of one ingest request: elapsed time per phase, plus the few
 * facts that make a slow one diagnosable.
 */
export class RequestTrace {
  readonly startedAt: number;
  private cursor: number;
  private readonly spans: Record<Phase, number> = {
    auth: 0,
    read: 0,
    enqueue: 0,
  };

  /** Whether this isolate resolved the API key without touching D1. */
  keyCacheHit = false;
  /** Request body size in bytes, after any gzip decode. */
  bodyBytes = 0;
  /** Queue messages produced — 1 on the fast path, N when the body is chunked. */
  queueMessages = 0;
  /**
   * Whether the caller stopped waiting for the queue ack and the send was
   * handed to `waitUntil` (see `src/enqueue.ts`). Only true when
   * `QUEUE_ACK_DEADLINE_MS` is on, so every event predating that switch reads
   * the same as before.
   */
  enqueueHandedOff = false;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.cursor = this.startedAt;
  }

  /** Close the span that ended with the `await` that just resolved. */
  mark(phase: Phase): void {
    const t = this.now();
    this.spans[phase] += t - this.cursor;
    this.cursor = t;
  }

  /**
   * Close the `enqueue` span and record what it produced.
   *
   * The span closes when the Worker stopped waiting, which is the number that
   * answers "how long did the client wait": the full send when it acked in
   * time, the deadline when it did not. `handedOff` is what tells the two
   * apart afterwards.
   */
  enqueued(messages: number, handedOff = false): void {
    this.mark("enqueue");
    this.queueMessages = messages;
    this.enqueueHandedOff = handedOff;
  }

  span(phase: Phase): number {
    return this.spans[phase];
  }

  totalMs(): number {
    return this.now() - this.startedAt;
  }
}

/**
 * Threshold in milliseconds from the `SLOW_REQUEST_MS` var. `0` disables
 * reporting entirely; anything unset or unparseable falls back to the default
 * rather than silently turning instrumentation off.
 */
export function resolveSlowRequestMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SLOW_REQUEST_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLOW_REQUEST_MS;
  return n;
}

/** One slow ingest request, flattened for logging. */
export interface SlowRequest {
  route: string;
  format: string;
  status: number;
  /** The API key's name — the `logs.events.source` the request was writing to. */
  ingestSource: string;
  totalMs: number;
  authMs: number;
  readMs: number;
  enqueueMs: number;
  keyCacheHit: boolean;
  bodyBytes: number;
  queueMessages: number;
  /**
   * Present, and always `true`, only when the caller's wait for the queue ack
   * hit `QUEUE_ACK_DEADLINE_MS` and the send was handed to `waitUntil`. Absent
   * otherwise, so an event from the default (deadline off) configuration is
   * byte-identical to one from before the deadline existed.
   */
  enqueueHandedOff?: true;
  colo?: string;
  rayId?: string;
}

export function buildSlowRequest(
  trace: RequestTrace,
  fields: {
    route: string;
    format: string;
    status: number;
    ingestSource: string;
    colo?: string;
    rayId?: string;
  },
): SlowRequest {
  return {
    ...fields,
    totalMs: trace.totalMs(),
    authMs: trace.span("auth"),
    readMs: trace.span("read"),
    enqueueMs: trace.span("enqueue"),
    keyCacheHit: trace.keyCacheHit,
    bodyBytes: trace.bodyBytes,
    queueMessages: trace.queueMessages,
    ...(trace.enqueueHandedOff ? { enqueueHandedOff: true as const } : {}),
  };
}

/**
 * Render a slow request as a single CLEF line, so it travels the same
 * Worker → queue → consumer → ClickHouse path as every other event and needs
 * no storage of its own.
 *
 * `@mt` is a fixed template: the consumer derives `event_type` from it, so
 * holding it constant keeps every slow-request event groupable by that column.
 */
export function slowRequestCLEF(r: SlowRequest, at: string): string {
  const event: Record<string, unknown> = {
    "@t": at,
    "@l": "Warning",
    "@mt":
      "Slow ingest request: {Route} took {TotalMs} ms (auth {AuthMs}, read {ReadMs}, enqueue {EnqueueMs})",
    Route: r.route,
    Format: r.format,
    Status: r.status,
    IngestSource: r.ingestSource,
    TotalMs: r.totalMs,
    AuthMs: r.authMs,
    ReadMs: r.readMs,
    EnqueueMs: r.enqueueMs,
    KeyCacheHit: r.keyCacheHit,
    BodyBytes: r.bodyBytes,
    QueueMessages: r.queueMessages,
  };
  if (r.enqueueHandedOff) event.EnqueueHandedOff = true;
  if (r.colo) event.Colo = r.colo;
  if (r.rayId) event.RayId = r.rayId;
  return `${JSON.stringify(event)}\n`;
}

/**
 * A queue send that failed *after* its response had already gone out — only
 * reachable once `QUEUE_ACK_DEADLINE_MS` is on and a send was handed off.
 *
 * This is the one loss the handoff can cause, and the client cannot see it: it
 * was told 201. Reporting it is the whole reason the handoff is allowed to
 * exist, so it renders as an `Error`, not a `Warning`, with its own `@mt` so
 * the consumer's derived `event_type` separates it from `slow-ingest-request`
 * and it can be alerted on by itself.
 */
export interface EnqueueFailure {
  route: string;
  format: string;
  /** The API key's name — the `logs.events.source` whose events were lost. */
  ingestSource: string;
  /** Messages the failed send would have produced. */
  queueMessages: number;
  bodyBytes: number;
  /** How long the caller waited before the handoff, in milliseconds. */
  waitedMs: number;
  error: string;
  colo?: string;
  rayId?: string;
}

export function enqueueFailureCLEF(f: EnqueueFailure, at: string): string {
  const event: Record<string, unknown> = {
    "@t": at,
    "@l": "Error",
    "@mt":
      "Ingest enqueue failed after the response was sent: {Route} lost {QueueMessages} message(s) for {IngestSource}",
    Route: f.route,
    Format: f.format,
    IngestSource: f.ingestSource,
    QueueMessages: f.queueMessages,
    BodyBytes: f.bodyBytes,
    WaitedMs: f.waitedMs,
    Error: f.error,
  };
  if (f.colo) event.Colo = f.colo;
  if (f.rayId) event.RayId = f.rayId;
  return `${JSON.stringify(event)}\n`;
}

/**
 * Queue-borne telemetry kinds, each with its own throttle budget.
 *
 * They are separate because they compete for the same scarce thing — messages
 * on a queue that is already struggling — but are not equally replaceable. A
 * degradation produces `slow-request` events continuously, while
 * `enqueue-failure` is rare and marks events that are actually gone. Sharing
 * one budget would let the common event crowd out the irreplaceable one at
 * exactly the moment both fire.
 */
export type TelemetryChannel = "slow-request" | "enqueue-failure";

// Isolate-scoped, like the key cache in `keys.ts`: shared by every request this
// isolate serves, and reset when it is evicted. Throttling per isolate rather
// than globally is deliberate — a fleet-wide degradation is visible across many
// isolates at once, which is the signal, while a single hot isolate cannot
// flood the queue on its own.
const lastTelemetryAt: Record<TelemetryChannel, number> = {
  "slow-request": 0,
  "enqueue-failure": 0,
};

/**
 * True at most once per `TELEMETRY_MIN_INTERVAL_MS` per channel. Records the
 * emission.
 */
export function shouldEmitTelemetry(
  now: number = Date.now(),
  channel: TelemetryChannel = "slow-request",
): boolean {
  const last = lastTelemetryAt[channel];
  if (last !== 0 && now - last < TELEMETRY_MIN_INTERVAL_MS) {
    return false;
  }
  lastTelemetryAt[channel] = now;
  return true;
}

/** Test-only. Clears every module-level throttle between cases. */
export function __resetTelemetryThrottle(): void {
  for (const channel of Object.keys(lastTelemetryAt) as TelemetryChannel[]) {
    lastTelemetryAt[channel] = 0;
  }
}
