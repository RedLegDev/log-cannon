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

/** Property trees nested deeper than this are rejected at parse time. Real
 * logs sit far below it; past it, recursive rendering and serialization can
 * overflow the stack and take every sibling row in the batch with them. */
export const MAX_NESTING_DEPTH = 64;

export class NestingTooDeepError extends Error {
  override name = "NestingTooDeepError";
  constructor() {
    super(`nesting deeper than ${MAX_NESTING_DEPTH} levels`);
  }
}

/** True when a decoded JSON value nests containers deeper than `max` (an
 * object or array counts as one level). Iterative, so it can't overflow. */
export function nestingExceeds(value: unknown, max = MAX_NESTING_DEPTH): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (depth > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

/**
 * Set a key as an own data property. Plain assignment of "__proto__" (a legal
 * JSON key, and one producers control) would set the object's prototype and
 * silently drop the value.
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// RFC 3339 needs a four-digit year: 0001-01-01T00:00:00.000Z … 9999-12-31T23:59:59.999Z.
const MIN_TS_MS = -62_135_596_800_000;
const MAX_TS_MS = 253_402_300_799_999;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace lone UTF-16 surrogates with U+FFFD, as Go's decoder did. A row
 * carrying one can't be encoded as UTF-8 and the stream would drop it. */
export function wellFormed(s: string): string {
  const native = s as { isWellFormed?: () => boolean; toWellFormed?: () => string };
  if (native.isWellFormed && native.toWellFormed) {
    return native.isWellFormed() ? s : native.toWellFormed();
  }
  return s.replace(LONE_SURROGATE, "�");
}

function wellFormedTree(v: unknown): unknown {
  if (typeof v === "string") return wellFormed(v);
  if (Array.isArray(v)) return v.map(wellFormedTree);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) setOwn(out, wellFormed(k), wellFormedTree(x));
    return out;
  }
  return v;
}

/** What a parser decides about an event; the builder fills the rest. */
export interface RowFields {
  /** Event time in epoch ms. Out of RFC 3339 range (or NaN) becomes the
   * receive time, as an unparseable time already does. */
  tsMs: number;
  source: string;
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

/**
 * The one place rows are made. Every string that reaches a row passes through
 * wellFormed here, so no parser can forget it, and the request-scoped fields
 * are computed once per request rather than per row.
 */
export function rowBuilder(ctx: ParseContext, format: LogFormat): (f: RowFields) => LogRow {
  const receivedAt = ctx.receivedAt.toISOString();
  const receivedMs = ctx.receivedAt.getTime();
  const keyId = wellFormed(ctx.keyId);
  const opt = (s: string | null) => (s === null ? null : wellFormed(s));
  return (f) => ({
    id: crypto.randomUUID(),
    ts: new Date(f.tsMs >= MIN_TS_MS && f.tsMs <= MAX_TS_MS ? f.tsMs : receivedMs).toISOString(),
    received_at: receivedAt,
    source: wellFormed(f.source),
    key_id: keyId,
    format,
    kind: f.kind,
    level: wellFormed(f.level),
    message: wellFormed(f.message),
    message_template: wellFormed(f.message_template),
    event_type: wellFormed(f.event_type),
    exception: wellFormed(f.exception),
    trace_id: opt(f.trace_id),
    span_id: opt(f.span_id),
    parent_span_id: opt(f.parent_span_id),
    duration_ms: f.duration_ms,
    properties: wellFormedTree(f.properties) as Record<string, unknown>,
  });
}

const TS_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORMATS = new Set<LogFormat>(["clef", "otlp", "webhook", "api"]);
const KINDS = new Set<LogKind>(["log", "span"]);

function isWellFormed(s: string): boolean {
  return wellFormed(s) === s;
}

/**
 * Throw unless the row is one the `log_events_v1` stream will accept: every
 * required field a non-empty well-formed string, timestamps RFC 3339 in range,
 * optional fields of the right type, properties a JSON-serializable object
 * with well-formed keys and strings, and the whole row JSON-serializable.
 */
export function assertRowValid(row: LogRow): void {
  const fail = (why: string): never => {
    throw new Error(`invalid row: ${why}`);
  };
  for (const k of ["id", "ts", "received_at", "source", "key_id", "format", "kind", "level"] as const) {
    const v = row[k];
    if (typeof v !== "string" || v === "") fail(`${k} must be a non-empty string`);
    if (!isWellFormed(v)) fail(`${k} has a lone surrogate`);
  }
  for (const k of ["ts", "received_at"] as const) {
    if (!TS_FORMAT.test(row[k]) || Number.isNaN(Date.parse(row[k]))) fail(`${k} is not RFC 3339: ${row[k]}`);
  }
  if (!FORMATS.has(row.format)) fail(`unknown format ${row.format}`);
  if (!KINDS.has(row.kind)) fail(`unknown kind ${row.kind}`);
  for (const k of ["message", "message_template", "event_type", "exception"] as const) {
    if (typeof row[k] !== "string") fail(`${k} must be a string`);
    if (!isWellFormed(row[k])) fail(`${k} has a lone surrogate`);
  }
  for (const k of ["trace_id", "span_id", "parent_span_id"] as const) {
    const v = row[k];
    if (v !== null && (typeof v !== "string" || v === "" || !isWellFormed(v))) {
      fail(`${k} must be null or a non-empty string`);
    }
  }
  if (row.duration_ms !== null && !(typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms))) {
    fail("duration_ms must be null or a finite number");
  }
  const props = row.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props)) fail("properties must be an object");
  const stack: [unknown, number][] = [[props, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v === "string") {
      if (!isWellFormed(v)) fail("properties hold a lone surrogate");
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("properties hold a non-finite number");
    } else if (typeof v === "object" && v !== null) {
      if (depth > MAX_NESTING_DEPTH + 1) fail("properties nest too deeply");
      if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1]);
      else {
        if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
          fail("properties hold a non-plain object");
        }
        for (const [k, x] of Object.entries(v)) {
          if (!isWellFormed(k)) fail("properties hold a key with a lone surrogate");
          stack.push([x, depth + 1]);
        }
      }
    } else if (typeof v !== "boolean" && v !== null) {
      fail(`properties hold a ${typeof v}`);
    }
  }
  try {
    JSON.stringify(row);
  } catch (err) {
    fail(`not JSON-serializable: ${(err as Error).message}`);
  }
}
