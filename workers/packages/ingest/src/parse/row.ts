/**
 * The row shape written to the Basin stream `log_events_v1`. Field names and
 * nullability mirror `basin/log_events_v1.schema.json` exactly: a stream
 * accepts an event that doesn't match its schema and then silently drops it,
 * so drift here is data loss, not a type error.
 *
 * The string fields the Go consumer always set (`message`, `message_template`,
 * `event_type`, `exception`) keep its "" convention. The fields v2 promoted out
 * of `properties` (span identity and duration) are null when absent.
 */
export type LogFormat = "clef" | "otlp" | "webhook" | "api";
export type LogKind = "log" | "span";

export interface LogRow {
  id: string;
  /** Event time, RFC 3339 with milliseconds (`2026-01-01T00:00:00.000Z`). */
  ts: string;
  /** When the Worker accepted the request; `received_at - ts` is ingest lag. */
  received_at: string;
  source: string;
  key_id: string;
  format: LogFormat;
  kind: LogKind;
  level: string;
  message: string;
  message_template: string;
  event_type: string;
  exception: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  duration_ms: number | null;
  properties: Record<string, unknown>;
}

export interface ParseContext {
  /** Default source: the key's name. OTLP `service.name` and webhook preset
   * source fields override it per event. */
  source: string;
  keyId: string;
  /** Request receive time. Also the parser's clock: future event times clamp
   * to it, and events with no usable time take it. */
  receivedAt: Date;
  /** Edge-captured geo/network context, filled into CLEF properties only where
   * the event has no value of its own. */
  enrich?: Record<string, string>;
}

export interface ParseResult {
  rows: LogRow[];
  /** Lines or elements dropped as malformed while their siblings were kept. */
  skipped: number;
}

/** The whole payload is unusable: every line/element failed, or the body
 * isn't the format the route promised. */
export class ParseError extends Error {
  override name = "ParseError";
}

/** Fields every format fills the same way. */
export function baseRow(
  ctx: ParseContext,
  format: LogFormat,
  kind: LogKind,
): Pick<LogRow, "id" | "received_at" | "key_id" | "format" | "kind"> {
  return {
    id: crypto.randomUUID(),
    received_at: ctx.receivedAt.toISOString(),
    key_id: ctx.keyId,
    format,
    kind,
  };
}

/** The largest |epoch ms| a JS Date can hold. */
export const MAX_DATE_MS = 8.64e15;

/**
 * Set a key as an own data property. Plain assignment of "__proto__" (a legal
 * JSON key, and one producers control) would set the object's prototype and
 * silently drop the value.
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Epoch milliseconds → the row timestamp format. */
export function formatTs(ms: number): string {
  return new Date(ms).toISOString();
}
