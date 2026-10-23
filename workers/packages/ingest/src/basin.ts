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
import { ParseError, type LogRow, type ParseResult } from "./parse/row";

/** Structural view of a Pipelines stream binding (`[[pipelines]]`). */
export interface LogStream {
  send(records: LogRow[]): Promise<void>;
}

export type BasinFormat = "clef" | "webhook" | "otlp-logs" | "otlp-traces";

export interface BasinCopy {
  format: BasinFormat;
  body: Uint8Array;
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

export function parseCopy(copy: BasinCopy): ParseResult {
  const ctx = {
    source: copy.source,
    keyId: copy.keyId,
    receivedAt: copy.receivedAt,
    enrich: copy.enrich,
  };
  switch (copy.format) {
    case "clef":
      return parseCLEF(new TextDecoder().decode(copy.body), ctx);
    case "webhook":
      return parseWebhook(new TextDecoder().decode(copy.body), ctx, copy.preset);
    case "otlp-logs":
      return parseOTLPLogs(copy.body, copy.contentType, ctx);
    case "otlp-traces":
      return parseOTLPTraces(copy.body, copy.contentType, ctx);
  }
}

/** Split rows into sends whose serialised size stays under `maxChars`. A row
 * that alone exceeds it still goes out on its own; the stream rejecting it is
 * a reported failure, not a reason to hold back its siblings. */
export function batchRows(rows: LogRow[], maxChars = MAX_SEND_CHARS): LogRow[][] {
  const batches: LogRow[][] = [];
  let current: LogRow[] = [];
  let size = 2; // the surrounding []
  for (const row of rows) {
    const rowChars = JSON.stringify(row).length + 1;
    if (current.length > 0 && size + rowChars > maxChars) {
      batches.push(current);
      current = [];
      size = 2;
    }
    current.push(row);
    size += rowChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface BasinOutcome {
  rows: number;
  skipped: number;
  sends: number;
}

/** Parse and send one request's copy. Throws on a send failure (after the
 * batches before it went out) and on a ParseError; the caller reports. */
export async function writeCopy(
  stream: LogStream,
  copy: BasinCopy,
): Promise<BasinOutcome> {
  const { rows, skipped } = parseCopy(copy);
  const batches = batchRows(rows);
  for (const batch of batches) await stream.send(batch);
  return { rows: rows.length, skipped, sends: batches.length };
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
  return e instanceof ParseError ? "parse" : "send";
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
