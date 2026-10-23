// --- Basin dual-write (v2, refs #163) ---
//
// While the Queue → ClickHouse path is still the source of truth, every
// accepted request is also parsed here and its rows sent to the Basin stream
// `log_events_v1`. The copy is best-effort and off the response path: it runs
// in `waitUntil` after the queue has accepted the payload, so it can neither
// slow nor fail an ingest request. A failure is reported, never retried into
// the client. A send is retried briefly; rows the stream still won't take are
// spilled to R2 (`BASIN_SPILL`) and replayed by the cron (refs #166, see
// `basin-spill.ts`).

import { parseCLEF } from "./parse/clef";
import { parseOTLPLogs, parseOTLPTraces } from "./parse/otlp";
import { parseWebhook } from "./parse/webhook";
import type { LogRow, ParseResult } from "./parse/row";

/** Structural view of a Pipelines stream binding (`[[pipelines]]`). */
export interface LogStream {
  send(records: LogRow[]): Promise<void>;
}

export type BasinFormat = "clef" | "webhook" | "otlp-logs" | "otlp-traces";

export interface BasinCopy {
  format: BasinFormat;
  /**
   * The payload as the queue received it: one body, or the ≤90 KB chunks a
   * large body was split into. Each chunk is a complete payload of its format,
   * and the copy parses and sends chunk by chunk, so a 32 MB body never holds
   * more than one chunk's rows plus one pending send in memory.
   */
  bodies: Uint8Array[];
  contentType: string;
  source: string;
  keyId: string;
  receivedAt: Date;
  enrich?: Record<string, string>;
  preset?: string;
}

/**
 * Stream ingest requests are capped at 5 MB. Batches are measured in UTF-16
 * code units of the serialised rows (cheap) and cut at 1.5M, which stays
 * under 5 MB even if every unit encodes to 3 UTF-8 bytes. One huge request
 * becomes several sends instead of one rejected one.
 */
export const MAX_SEND_CHARS = 1_500_000;

/** `BASIN_WRITE` must be exactly "true" and the binding present. Anything
 * else — unset, "false", a typo, a missing binding — is off. */
export function basinWriteEnabled(
  flag: string | undefined,
  stream: LogStream | undefined,
): stream is LogStream {
  return flag?.trim() === "true" && stream !== undefined;
}

export function parseBody(copy: BasinCopy, body: Uint8Array): ParseResult {
  const ctx = {
    source: copy.source,
    keyId: copy.keyId,
    receivedAt: copy.receivedAt,
    enrich: copy.enrich,
  };
  switch (copy.format) {
    case "clef":
      return parseCLEF(new TextDecoder().decode(body), ctx);
    case "webhook":
      return parseWebhook(new TextDecoder().decode(body), ctx, copy.preset);
    case "otlp-logs":
      return parseOTLPLogs(body, copy.contentType, ctx);
    case "otlp-traces":
      return parseOTLPTraces(body, copy.contentType, ctx);
  }
}

/** Accumulates rows into sends whose serialised size stays under `maxChars`.
 * A row that alone exceeds it still goes out on its own; the stream rejecting
 * it is a reported failure, not a reason to hold back its siblings. */
export class RowBatcher {
  private batch: LogRow[] = [];
  private size = 2; // the surrounding []
  readonly ready: LogRow[][] = [];

  constructor(private readonly maxChars = MAX_SEND_CHARS) {}

  add(row: LogRow): void {
    const rowChars = JSON.stringify(row).length + 1;
    if (this.batch.length > 0 && this.size + rowChars > this.maxChars) this.cut();
    this.batch.push(row);
    this.size += rowChars;
  }

  /** Close the open batch, if any. */
  cut(): void {
    if (this.batch.length === 0) return;
    this.ready.push(this.batch);
    this.batch = [];
    this.size = 2;
  }
}

export function batchRows(rows: LogRow[], maxChars = MAX_SEND_CHARS): LogRow[][] {
  const b = new RowBatcher(maxChars);
  for (const row of rows) b.add(row);
  b.cut();
  return b.ready;
}

export interface BasinOutcome {
  rows: number;
  skipped: number;
  sends: number;
  /** Send attempts retried, across the whole copy. */
  retries: number;
  /** Rows written to the spill bucket for the replay to send later. */
  spilled: number;
  /** Rows neither sent nor spilled: no bucket, or its put failed too. */
  lost: number;
}

/** A copy that didn't send every row. `stage` says whether a body failed to
 * parse (its siblings were still sent) or a send failed (the rows after it
 * were spilled, or lost if the spill failed too). */
export class BasinCopyError extends Error {
  override name = "BasinCopyError";
  constructor(
    readonly stage: "parse" | "send",
    message: string,
    readonly outcome: BasinOutcome,
    /** Why the unsent rows weren't spilled, when they weren't. */
    readonly spillError?: string,
  ) {
    super(message);
  }
}

/**
 * Backoff before each retry of a failed send. The retries are a budget for the
 * whole copy, not per batch: a stream that is down fails every batch, and the
 * copy has to finish (spill included) inside `waitUntil`'s ~30 s after the
 * response. Worst case is four attempts and 7.5 s of waiting.
 */
export const SEND_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 5_000];

/**
 * Latest a retry may start, in milliseconds after the copy began. Leaves well
 * over half of `waitUntil`'s budget for the rest of the parse, the gzip and the
 * spill put, which is the step that actually saves the rows.
 */
export const SEND_RETRY_BUDGET_MS = 12_000;

/** Retry delays and sleep. Mutable so tests can run the retries without
 * waiting seconds of real time; nothing else should touch it. */
export const sendRetry = {
  delaysMs: SEND_RETRY_DELAYS_MS,
  sleep: (ms: number): Promise<void> => scheduler.wait(ms),
};

/** The part of the `BASIN_SPILL` R2 binding a copy writes with. */
export interface SpillBucket {
  put(key: string, value: Blob, options?: R2PutOptions): Promise<unknown>;
}

export const SPILL_PREFIX = "spill/";

/** `spill/<received_at ISO>/<uuid>.ndjson.gz`: a lexical list is oldest first. */
export function spillKey(receivedAt: Date): string {
  return `${SPILL_PREFIX}${receivedAt.toISOString()}/${crypto.randomUUID()}.ndjson.gz`;
}

/** The receive time a spill key was named for, or NaN for a foreign key. */
export function spillKeyTime(key: string): number {
  return Date.parse(key.slice(SPILL_PREFIX.length).split("/")[0] ?? "");
}

/**
 * Rows serialised as NDJSON into a gzip stream as they arrive, so a large copy
 * holds its compressed spill in memory rather than every parsed row.
 */
export class SpillWriter {
  rows = 0;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly out: Promise<ArrayBuffer>;

  constructor() {
    const gz = new CompressionStream("gzip");
    this.writer = gz.writable.getWriter();
    this.out = new Response(gz.readable).arrayBuffer();
  }

  async add(rows: LogRow[]): Promise<void> {
    if (!rows.length) return;
    await this.writer.write(new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`));
    this.rows += rows.length;
  }

  async finish(): Promise<Blob> {
    await this.writer.close();
    return new Blob([await this.out]);
  }
}

/** Gzipped NDJSON of `rows`, as a spill object holds them. */
export async function gzipRows(rows: LogRow[]): Promise<Blob> {
  const w = new SpillWriter();
  await w.add(rows);
  return w.finish();
}

/** Rows from a spill object's body. */
export async function gunzipRows(body: ReadableStream<Uint8Array>): Promise<LogRow[]> {
  const text = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as LogRow);
}

export interface CopyOptions {
  /** Where rows go when the stream stays down. Absent loses them, reported. */
  spill?: SpillBucket;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Parse and send one request's copy, a chunk at a time. A chunk that fails to
 * parse is skipped and the rest still go out, the way the consumer fails one
 * queue message and not its siblings.
 *
 * A failed send is retried from the copy's budget (`SEND_RETRY_DELAYS_MS`).
 * Once that is spent the stream is taken to be down: nothing more is sent, and
 * every row not yet sent (the failing batch, the batches behind it and the
 * bodies not yet parsed) goes to one spill object for the cron to replay. A
 * row is sent or spilled, never both. Whatever happened is reported through a
 * BasinCopyError, whose outcome counts the rows spilled and lost.
 */
export async function writeCopy(
  stream: LogStream,
  copy: BasinCopy,
  opts: CopyOptions = {},
): Promise<BasinOutcome> {
  const out: BasinOutcome = { rows: 0, skipped: 0, sends: 0, retries: 0, spilled: 0, lost: 0 };
  const batcher = new RowBatcher();
  // `Date.now()` advances across I/O, and every send and sleep is I/O.
  const started = Date.now();
  let parseError: string | undefined;
  let sendError: string | undefined;
  let spill: SpillWriter | undefined;
  let unspilled = 0;

  const send = async (batch: LogRow[]): Promise<boolean> => {
    for (;;) {
      try {
        await stream.send(batch);
        return true;
      } catch (e) {
        const delay = sendRetry.delaysMs[out.retries];
        if (delay === undefined || Date.now() - started + delay > SEND_RETRY_BUDGET_MS) {
          sendError = message(e);
          return false;
        }
        out.retries++;
        await sendRetry.sleep(delay);
      }
    }
  };

  const keep = async (rows: LogRow[]) => {
    if (!opts.spill) {
      unspilled += rows.length;
      return;
    }
    spill ??= new SpillWriter();
    await spill.add(rows);
  };

  const flush = async () => {
    while (batcher.ready.length > 0) {
      const batch = batcher.ready.shift()!;
      if (sendError === undefined && (await send(batch))) {
        out.sends++;
        out.rows += batch.length;
      } else {
        await keep(batch);
      }
    }
  };

  for (const body of copy.bodies) {
    let parsed: ParseResult;
    try {
      parsed = parseBody(copy, body);
    } catch (e) {
      parseError ??= message(e);
      out.skipped++;
      continue;
    }
    out.skipped += parsed.skipped;
    for (const row of parsed.rows) batcher.add(row);
    await flush();
  }
  batcher.cut();
  await flush();

  if (sendError !== undefined) {
    let spillError: string | undefined;
    if (!opts.spill) {
      spillError = "no spill bucket bound";
      out.lost = unspilled;
    } else if (spill) {
      try {
        const blob = await spill.finish();
        await opts.spill.put(spillKey(copy.receivedAt), blob, {
          httpMetadata: { contentType: "application/x-ndjson" },
          customMetadata: { rows: String(spill.rows) },
        });
        out.spilled = spill.rows;
      } catch (e) {
        spillError = message(e);
        out.lost = spill.rows;
      }
    }
    throw new BasinCopyError("send", sendError, out, spillError);
  }
  if (parseError !== undefined) throw new BasinCopyError("parse", parseError, out);
  return out;
}

export interface BasinFailure {
  route: string;
  format: BasinFormat;
  ingestSource: string;
  bodyBytes: number;
  stage: "parse" | "send";
  error: string;
  /** Rows saved to the spill bucket for the replay. */
  spilledRows?: number;
  /** Rows neither sent nor spilled. Non-zero is data loss. */
  lostRows?: number;
  /** Why the spill didn't happen, when it didn't. */
  spillError?: string;
}

export function classifyFailure(e: unknown): BasinFailure["stage"] {
  return e instanceof BasinCopyError ? e.stage : "send";
}

/**
 * Error only when rows are gone. A send failure whose rows all reached the
 * spill bucket is a Warning, like an unparseable body: the replay sends them.
 */
export function basinFailureCLEF(f: BasinFailure, at: string): string {
  const safe = f.stage === "parse" || (f.spilledRows !== undefined && !f.lostRows);
  return `${JSON.stringify({
    "@t": at,
    "@l": safe ? "Warning" : "Error",
    "@mt":
      "Basin copy failed at {Stage}: {Route} for {IngestSource}: {Error}",
    Stage: f.stage,
    Route: f.route,
    Format: f.format,
    IngestSource: f.ingestSource,
    BodyBytes: f.bodyBytes,
    Error: f.error,
    SpilledRows: f.spilledRows,
    LostRows: f.lostRows,
    SpillError: f.spillError,
  })}\n`;
}
