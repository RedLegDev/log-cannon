// --- Basin dual-write (v2, refs #163) ---
//
// While the Queue → ClickHouse path is still the source of truth, every
// accepted request is also parsed here and its rows sent to the Basin stream
// `log_events_v1`. The copy is best-effort and off the response path: it runs
// in `waitUntil` after the queue has accepted the payload, so it can neither
// slow nor fail an ingest request. A failure is reported, never retried into
// the client.

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
}

/** A copy that lost rows. `stage` says whether a body failed to parse (its
 * siblings were still sent) or a send failed (the rows after it weren't). */
export class BasinCopyError extends Error {
  override name = "BasinCopyError";
  constructor(
    readonly stage: "parse" | "send",
    message: string,
    readonly outcome: BasinOutcome,
  ) {
    super(message);
  }
}

/**
 * Parse and send one request's copy, a chunk at a time. A chunk that fails to
 * parse is skipped and the rest still go out, the way the consumer fails one
 * queue message and not its siblings. A failed send stops the copy, because
 * the stream is what's down. Either way the outcome so far is reported
 * through a BasinCopyError.
 */
export async function writeCopy(
  stream: LogStream,
  copy: BasinCopy,
): Promise<BasinOutcome> {
  const out: BasinOutcome = { rows: 0, skipped: 0, sends: 0 };
  const batcher = new RowBatcher();
  let parseError: string | undefined;

  const flush = async () => {
    while (batcher.ready.length > 0) {
      const batch = batcher.ready.shift()!;
      try {
        await stream.send(batch);
      } catch (e) {
        throw new BasinCopyError("send", e instanceof Error ? e.message : String(e), out);
      }
      out.sends++;
      out.rows += batch.length;
    }
  };

  for (const body of copy.bodies) {
    let parsed: ParseResult;
    try {
      parsed = parseBody(copy, body);
    } catch (e) {
      parseError ??= e instanceof Error ? e.message : String(e);
      out.skipped++;
      continue;
    }
    out.skipped += parsed.skipped;
    for (const row of parsed.rows) batcher.add(row);
    await flush();
  }
  batcher.cut();
  await flush();

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
}

export function classifyFailure(e: unknown): BasinFailure["stage"] {
  return e instanceof BasinCopyError ? e.stage : "send";
}

export function basinFailureCLEF(f: BasinFailure, at: string): string {
  return `${JSON.stringify({
    "@t": at,
    "@l": f.stage === "send" ? "Error" : "Warning",
    "@mt":
      "Basin copy failed at {Stage}: {Route} for {IngestSource}: {Error}",
    Stage: f.stage,
    Route: f.route,
    Format: f.format,
    IngestSource: f.ingestSource,
    BodyBytes: f.bodyBytes,
    Error: f.error,
  })}\n`;
}
