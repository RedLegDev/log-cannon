import { computeEventType, goFormatG, goJSON, nanosToMs } from "./go-compat";
import { ProtoReader, WIRE_FIXED64, WIRE_LEN, WIRE_VARINT } from "./protowire";
import {
  baseRow,
  formatTs,
  ParseError,
  setOwn,
  type LogRow,
  type ParseContext,
  type ParseResult,
} from "./row";

/**
 * OTLP/HTTP logs and traces (`/v1/logs`, `/v1/traces`, `/ingest/otlp/*`),
 * protobuf or JSON. Port of queue-consumer/otlp.go. Each body decodes into the
 * plain structures below, and one set of converters turns those into rows, so
 * protobuf and JSON can't disagree about what a log record or span means.
 */

type AnyValue =
  | { kind: "string"; v: string }
  | { kind: "bool"; v: boolean }
  | { kind: "int"; v: bigint }
  | { kind: "double"; v: number }
  | { kind: "bytes"; v: Uint8Array }
  | { kind: "array"; v: (AnyValue | undefined)[] }
  | { kind: "kvlist"; v: KeyValue[] }
  | { kind: "none" };

interface KeyValue {
  key: string;
  value: AnyValue | undefined;
}

interface LogRecord {
  timeUnixNano: bigint;
  observedTimeUnixNano: bigint;
  severityNumber: number;
  severityText: string;
  body: AnyValue | undefined;
  attributes: KeyValue[];
  traceId: Uint8Array;
  spanId: Uint8Array;
}

interface Span {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId: Uint8Array;
  name: string;
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: KeyValue[];
  status: { code: number; message: string } | undefined;
}

interface ResourceGroup<T> {
  resourceAttributes: KeyValue[];
  items: T[];
}

const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

// ---------------------------------------------------------------------------
// Entry points

export function parseOTLPLogs(
  body: Uint8Array,
  contentType: string,
  ctx: ParseContext,
): ParseResult {
  const groups = decode(body, contentType, decodeLogsProto, decodeLogsJSON);
  const rows: LogRow[] = [];
  for (const g of groups) {
    const source = serviceName(g.resourceAttributes) || ctx.source;
    for (const lr of g.items) rows.push(logRecordToRow(lr, source, ctx));
  }
  return { rows, skipped: 0 };
}

export function parseOTLPTraces(
  body: Uint8Array,
  contentType: string,
  ctx: ParseContext,
): ParseResult {
  const groups = decode(body, contentType, decodeTracesProto, decodeTracesJSON);
  const rows: LogRow[] = [];
  for (const g of groups) {
    const source = serviceName(g.resourceAttributes) || ctx.source;
    for (const span of g.items) rows.push(spanToRow(span, source, ctx));
  }
  return { rows, skipped: 0 };
}

/** The exact protobuf media types decode as protobuf. Anything else is tried
 * as JSON first and then as protobuf, as the Go consumer did. */
function decode<T>(
  body: Uint8Array,
  contentType: string,
  proto: (b: Uint8Array) => ResourceGroup<T>[],
  json: (v: unknown) => ResourceGroup<T>[],
): ResourceGroup<T>[] {
  if (contentType === "application/x-protobuf" || contentType === "application/proto") {
    try {
      return proto(body);
    } catch (err) {
      throw new ParseError(`protobuf: ${(err as Error).message}`);
    }
  }
  let jsonErr: Error;
  try {
    return json(JSON.parse(new TextDecoder().decode(body)));
  } catch (err) {
    jsonErr = err as Error;
  }
  try {
    return proto(body);
  } catch (err) {
    throw new ParseError(`json=${jsonErr.message}, proto=${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Rows

function logRecordToRow(lr: LogRecord, source: string, ctx: ParseContext): LogRow {
  let ts = ctx.receivedAt.getTime();
  if (lr.timeUnixNano > 0n) ts = nanosToMs(BigInt.asIntN(64, lr.timeUnixNano));
  else if (lr.observedTimeUnixNano > 0n) ts = nanosToMs(BigInt.asIntN(64, lr.observedTimeUnixNano));

  const message = anyValueToString(lr.body);
  return {
    ...baseRow(ctx, "otlp", "log"),
    ts: formatTs(ts),
    source,
    level: severityToLevel(lr.severityText, lr.severityNumber),
    message,
    message_template: "",
    event_type: computeEventType("", message),
    exception: "",
    trace_id: idOrNull(lr.traceId),
    span_id: idOrNull(lr.spanId),
    parent_span_id: null,
    duration_ms: null,
    properties: toProperties(lr.attributes),
  };
}

const SPAN_TEMPLATE = "{Name} [{Kind}] {Status}";

function spanToRow(span: Span, source: string, ctx: ParseContext): LogRow {
  let ts = ctx.receivedAt.getTime();
  if (span.startTimeUnixNano > 0n) ts = nanosToMs(BigInt.asIntN(64, span.startTimeUnixNano));

  const code = span.status?.code ?? 0;
  const level = span.status && code === STATUS_CODE_ERROR ? "Error" : "Information";

  let status = "OK";
  if (span.status) {
    status = code === STATUS_CODE_ERROR ? "ERROR" : code === STATUS_CODE_OK ? "OK" : "UNSET";
    if (span.status.message) status += ": " + span.status.message;
  }
  const message = `${span.name} [${spanKindToString(span.kind)}] ${status}`;

  // Go subtracted as uint64, so an end before the start wrapped to ~584 years.
  // A negative or wrapped duration isn't a duration; leave it null.
  const { startTimeUnixNano: start, endTimeUnixNano: end } = span;
  const duration =
    start > 0n && end > 0n && end >= start ? Number(end - start) / 1e6 : null;

  return {
    ...baseRow(ctx, "otlp", "span"),
    ts: formatTs(ts),
    source,
    level,
    message,
    message_template: SPAN_TEMPLATE,
    event_type: computeEventType(SPAN_TEMPLATE, message),
    exception: "",
    // Go kept these in properties (traceId, spanId, parentSpanId, durationMs);
    // v2 promotes them to columns and leaves properties to the attributes.
    trace_id: idOrNull(span.traceId),
    span_id: idOrNull(span.spanId),
    parent_span_id: idOrNull(span.parentSpanId),
    duration_ms: duration,
    properties: toProperties(span.attributes),
  };
}

export function severityToLevel(text: string, num: number): string {
  if (text) {
    const upper = text.toUpperCase();
    if (upper.startsWith("TRACE") || upper.startsWith("DEBUG")) return "Debug";
    if (upper.startsWith("INFO")) return "Information";
    if (upper.startsWith("WARN")) return "Warning";
    if (upper.startsWith("ERROR")) return "Error";
    if (upper.startsWith("FATAL")) return "Fatal";
  }
  if (num > 0) {
    if (num <= 4) return "Verbose";
    if (num <= 8) return "Debug";
    if (num <= 12) return "Information";
    if (num <= 16) return "Warning";
    if (num <= 20) return "Error";
    return "Fatal";
  }
  return "Information";
}

const SPAN_KINDS = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];

export function spanKindToString(kind: number): string {
  return SPAN_KINDS[kind] ?? "UNSPECIFIED";
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

function idOrNull(b: Uint8Array): string | null {
  return b.length > 0 ? hex(b) : null;
}

function serviceName(attrs: KeyValue[]): string {
  const kv = attrs.find((a) => a.key === "service.name");
  return kv ? anyValueToString(kv.value) : "";
}

/** The decoded value Go marshalled: int64 stays exact (bigint) here. */
function toInterface(v: AnyValue | undefined): unknown {
  if (!v) return null;
  switch (v.kind) {
    case "string":
    case "bool":
    case "int":
    case "double":
      return v.v;
    case "bytes":
      return hex(v.v);
    case "array":
      return v.v.map(toInterface);
    case "kvlist":
      return attributesToMap(v.v);
    case "none":
      return null;
  }
}

function attributesToMap(attrs: KeyValue[]): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const kv of attrs) setOwn(m, kv.key, toInterface(kv.value));
  return m;
}

function anyValueToString(v: AnyValue | undefined): string {
  if (!v) return "";
  switch (v.kind) {
    case "string":
      return v.v;
    case "int":
      return v.v.toString();
    case "double":
      return goFormatG(v.v);
    case "bool":
      return v.v ? "true" : "false";
    case "bytes":
      return hex(v.v);
    default:
      return goJSON(toInterface(v));
  }
}

/**
 * Attributes as a JSON-safe object for the `properties` column. An int64 that
 * fits a double exactly stays a number; a larger one becomes its decimal
 * string. A non-finite double becomes "NaN"/"Infinity" (Go's json.Marshal
 * failed on those and dropped every property of the event).
 */
function toProperties(attrs: KeyValue[]): Record<string, unknown> {
  return jsonSafe(attributesToMap(attrs)) as Record<string, unknown>;
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) setOwn(out, k, jsonSafe(x));
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Protobuf (opentelemetry-proto v1 field numbers)

function decodeLogsProto(buf: Uint8Array): ResourceGroup<LogRecord>[] {
  const groups: ResourceGroup<LogRecord>[] = [];
  const req = new ProtoReader(buf);
  // ExportLogsServiceRequest.resource_logs = 1
  req.fields((f, wt) => {
    if (f !== 1 || wt !== WIRE_LEN) return false;
    groups.push(readResourceGroup(req.message(), readLogRecord));
    return true;
  });
  return groups;
}

function decodeTracesProto(buf: Uint8Array): ResourceGroup<Span>[] {
  const groups: ResourceGroup<Span>[] = [];
  const req = new ProtoReader(buf);
  // ExportTraceServiceRequest.resource_spans = 1
  req.fields((f, wt) => {
    if (f !== 1 || wt !== WIRE_LEN) return false;
    groups.push(readResourceGroup(req.message(), readSpan));
    return true;
  });
  return groups;
}

/** ResourceLogs / ResourceSpans share a layout: resource = 1, and scope_logs /
 * scope_spans = 2, whose log_records / spans are field 2 again. */
function readResourceGroup<T>(r: ProtoReader, readItem: (r: ProtoReader) => T): ResourceGroup<T> {
  const group: ResourceGroup<T> = { resourceAttributes: [], items: [] };
  r.fields((f, wt) => {
    if (wt !== WIRE_LEN) return false;
    if (f === 1) {
      group.resourceAttributes.push(...readResource(r.message()));
      return true;
    }
    if (f === 2) {
      const scope = r.message();
      scope.fields((f2, wt2) => {
        if (f2 !== 2 || wt2 !== WIRE_LEN) return false;
        group.items.push(readItem(scope.message()));
        return true;
      });
      return true;
    }
    return false;
  });
  return group;
}

/** Resource.attributes = 1 */
function readResource(r: ProtoReader): KeyValue[] {
  const attrs: KeyValue[] = [];
  r.fields((f, wt) => {
    if (f !== 1 || wt !== WIRE_LEN) return false;
    attrs.push(readKeyValue(r.message()));
    return true;
  });
  return attrs;
}

/** KeyValue: key = 1, value = 2 */
function readKeyValue(r: ProtoReader): KeyValue {
  const kv: KeyValue = { key: "", value: undefined };
  r.fields((f, wt) => {
    if (wt !== WIRE_LEN) return false;
    if (f === 1) kv.key = r.string();
    else if (f === 2) kv.value = readAnyValue(r.message());
    else return false;
    return true;
  });
  return kv;
}

/** AnyValue oneof: string 1, bool 2, int 3, double 4, array 5, kvlist 6, bytes 7.
 * The last member on the wire wins, as in Go. */
function readAnyValue(r: ProtoReader): AnyValue {
  let v: AnyValue = { kind: "none" };
  r.fields((f, wt) => {
    if (f === 1 && wt === WIRE_LEN) v = { kind: "string", v: r.string() };
    else if (f === 2 && wt === WIRE_VARINT) v = { kind: "bool", v: r.varint() !== 0n };
    else if (f === 3 && wt === WIRE_VARINT) v = { kind: "int", v: r.int64() };
    else if (f === 4 && wt === WIRE_FIXED64) v = { kind: "double", v: r.double() };
    else if (f === 5 && wt === WIRE_LEN) {
      // ArrayValue.values = 1
      const arr = r.message();
      const values: AnyValue[] = [];
      arr.fields((f2, wt2) => {
        if (f2 !== 1 || wt2 !== WIRE_LEN) return false;
        values.push(readAnyValue(arr.message()));
        return true;
      });
      v = { kind: "array", v: values };
    } else if (f === 6 && wt === WIRE_LEN) {
      // KeyValueList.values = 1
      const list = r.message();
      const values: KeyValue[] = [];
      list.fields((f2, wt2) => {
        if (f2 !== 1 || wt2 !== WIRE_LEN) return false;
        values.push(readKeyValue(list.message()));
        return true;
      });
      v = { kind: "kvlist", v: values };
    } else if (f === 7 && wt === WIRE_LEN) v = { kind: "bytes", v: r.bytes() };
    else return false;
    return true;
  });
  return v;
}

/** LogRecord: time 1 (fixed64), severity_number 2, severity_text 3, body 5,
 * attributes 6, trace_id 9, span_id 10, observed_time 11 (fixed64). */
function readLogRecord(r: ProtoReader): LogRecord {
  const lr: LogRecord = {
    timeUnixNano: 0n,
    observedTimeUnixNano: 0n,
    severityNumber: 0,
    severityText: "",
    body: undefined,
    attributes: [],
    traceId: EMPTY,
    spanId: EMPTY,
  };
  r.fields((f, wt) => {
    if (f === 1 && wt === WIRE_FIXED64) lr.timeUnixNano = r.fixed64();
    else if (f === 11 && wt === WIRE_FIXED64) lr.observedTimeUnixNano = r.fixed64();
    else if (f === 2 && wt === WIRE_VARINT) lr.severityNumber = r.int32();
    else if (f === 3 && wt === WIRE_LEN) lr.severityText = r.string();
    else if (f === 5 && wt === WIRE_LEN) lr.body = readAnyValue(r.message());
    else if (f === 6 && wt === WIRE_LEN) lr.attributes.push(readKeyValue(r.message()));
    else if (f === 9 && wt === WIRE_LEN) lr.traceId = r.bytes();
    else if (f === 10 && wt === WIRE_LEN) lr.spanId = r.bytes();
    else return false;
    return true;
  });
  return lr;
}

/** Span: trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6, start 7 and
 * end 8 (fixed64), attributes 9, status 15 (message 2, code 3). */
function readSpan(r: ProtoReader): Span {
  const span: Span = {
    traceId: EMPTY,
    spanId: EMPTY,
    parentSpanId: EMPTY,
    name: "",
    kind: 0,
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    attributes: [],
    status: undefined,
  };
  r.fields((f, wt) => {
    if (f === 1 && wt === WIRE_LEN) span.traceId = r.bytes();
    else if (f === 2 && wt === WIRE_LEN) span.spanId = r.bytes();
    else if (f === 4 && wt === WIRE_LEN) span.parentSpanId = r.bytes();
    else if (f === 5 && wt === WIRE_LEN) span.name = r.string();
    else if (f === 6 && wt === WIRE_VARINT) span.kind = r.int32();
    else if (f === 7 && wt === WIRE_FIXED64) span.startTimeUnixNano = r.fixed64();
    else if (f === 8 && wt === WIRE_FIXED64) span.endTimeUnixNano = r.fixed64();
    else if (f === 9 && wt === WIRE_LEN) span.attributes.push(readKeyValue(r.message()));
    else if (f === 15 && wt === WIRE_LEN) {
      const st = r.message();
      const status = span.status ?? { code: 0, message: "" };
      st.fields((f2, wt2) => {
        if (f2 === 2 && wt2 === WIRE_LEN) status.message = st.string();
        else if (f2 === 3 && wt2 === WIRE_VARINT) status.code = st.int32();
        else return false;
        return true;
      });
      span.status = status;
    } else return false;
    return true;
  });
  return span;
}

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------
// JSON (OTLP/HTTP JSON encoding: protobuf JSON mapping, lowerCamelCase or
// original field names, int64 as string or number, enums as number or name)
//
// Two deliberate differences from Go's protojson:
// - trace and span ids are read as hex, per the OTLP JSON spec. protojson
//   base64-decoded them, which turned a 32-hex-digit trace id into 24 bytes of
//   garbage. Base64 is still accepted when the value isn't hex.
// - unknown fields are ignored instead of failing the whole request.

type Obj = Record<string, unknown>;

function get(o: Obj, camel: string, snake?: string): unknown {
  const v = o[camel] ?? (snake ? o[snake] : undefined);
  return v === null ? undefined : v;
}

function obj(v: unknown, what: string): Obj | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what}: expected object`);
  return v as Obj;
}

function arr(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${what}: expected array`);
  return v;
}

function str(v: unknown, what: string): string {
  if (v === undefined) return "";
  if (typeof v !== "string") throw new Error(`${what}: expected string`);
  return v;
}

function int64(v: unknown, what: string, unsigned: boolean): bigint {
  if (v === undefined) return 0n;
  let n: bigint;
  if (typeof v === "number" && Number.isInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^-?\d+$/.test(v)) n = BigInt(v);
  else throw new Error(`${what}: expected integer`);
  if (unsigned ? n < 0n || n > 0xffffffffffffffffn : BigInt.asIntN(64, n) !== n) {
    throw new Error(`${what}: out of range`);
  }
  return n;
}

function enumValue(v: unknown, names: Record<string, number>, what: string): number {
  if (v === undefined) return 0;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && Object.hasOwn(names, v)) return names[v];
  throw new Error(`${what}: invalid enum value`);
}

function double(v: unknown, what: string): number {
  if (typeof v === "number") return v;
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  throw new Error(`${what}: expected number`);
}

function base64Bytes(s: string, what: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`${what}: invalid base64`);
  }
}

function idBytes(v: unknown, what: string): Uint8Array {
  const s = str(v, what);
  if (s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s)) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return base64Bytes(s, what);
}

function enumNames(prefix: string, names: string[]): Record<string, number> {
  return Object.fromEntries(names.map((n, i) => [prefix + n, i]));
}

const SEVERITY_NAMES = enumNames(
  "SEVERITY_NUMBER_",
  ["UNSPECIFIED"].concat(
    ...["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].map((l) => [l, l + "2", l + "3", l + "4"]),
  ),
);
const SPAN_KIND_NAMES = enumNames("SPAN_KIND_", SPAN_KINDS);
const STATUS_CODE_NAMES = enumNames("STATUS_CODE_", ["UNSET", "OK", "ERROR"]);

function jsonAnyValue(v: unknown): AnyValue | undefined {
  const o = obj(v, "AnyValue");
  if (!o) return undefined;
  let out: AnyValue = { kind: "none" };
  const s = get(o, "stringValue", "string_value");
  const b = get(o, "boolValue", "bool_value");
  const i = get(o, "intValue", "int_value");
  const d = get(o, "doubleValue", "double_value");
  const a = get(o, "arrayValue", "array_value");
  const kv = get(o, "kvlistValue", "kvlist_value");
  const by = get(o, "bytesValue", "bytes_value");
  if (s !== undefined) out = { kind: "string", v: str(s, "stringValue") };
  else if (b !== undefined) {
    if (typeof b !== "boolean") throw new Error("boolValue: expected boolean");
    out = { kind: "bool", v: b };
  } else if (i !== undefined) out = { kind: "int", v: int64(i, "intValue", false) };
  else if (d !== undefined) out = { kind: "double", v: double(d, "doubleValue") };
  else if (a !== undefined) {
    out = { kind: "array", v: arr(obj(a, "arrayValue")?.values, "values").map((x) => jsonAnyValue(x)) };
  } else if (kv !== undefined) {
    out = { kind: "kvlist", v: arr(obj(kv, "kvlistValue")?.values, "values").map(jsonKeyValue) };
  } else if (by !== undefined) out = { kind: "bytes", v: base64Bytes(str(by, "bytesValue"), "bytesValue") };
  return out;
}

function jsonKeyValue(v: unknown): KeyValue {
  const o = obj(v, "KeyValue") ?? {};
  return { key: str(get(o, "key"), "key"), value: jsonAnyValue(get(o, "value")) };
}

function jsonGroups<T>(
  root: unknown,
  resourceField: [string, string],
  scopeField: [string, string],
  itemField: [string, string],
  readItem: (o: Obj) => T,
): ResourceGroup<T>[] {
  const req = obj(root, "request");
  if (!req) throw new Error("request: expected object");
  return arr(get(req, ...resourceField), resourceField[0]).map((rv) => {
    const r = obj(rv, resourceField[0]) ?? {};
    const resource = obj(get(r, "resource"), "resource");
    const group: ResourceGroup<T> = {
      resourceAttributes: resource ? arr(get(resource, "attributes"), "attributes").map(jsonKeyValue) : [],
      items: [],
    };
    for (const sv of arr(get(r, ...scopeField), scopeField[0])) {
      const scope = obj(sv, scopeField[0]) ?? {};
      for (const iv of arr(get(scope, ...itemField), itemField[0])) {
        group.items.push(readItem(obj(iv, itemField[0]) ?? {}));
      }
    }
    return group;
  });
}

function decodeLogsJSON(root: unknown): ResourceGroup<LogRecord>[] {
  return jsonGroups(
    root,
    ["resourceLogs", "resource_logs"],
    ["scopeLogs", "scope_logs"],
    ["logRecords", "log_records"],
    (o): LogRecord => ({
      timeUnixNano: int64(get(o, "timeUnixNano", "time_unix_nano"), "timeUnixNano", true),
      observedTimeUnixNano: int64(
        get(o, "observedTimeUnixNano", "observed_time_unix_nano"),
        "observedTimeUnixNano",
        true,
      ),
      severityNumber: enumValue(get(o, "severityNumber", "severity_number"), SEVERITY_NAMES, "severityNumber"),
      severityText: str(get(o, "severityText", "severity_text"), "severityText"),
      body: jsonAnyValue(get(o, "body")),
      attributes: arr(get(o, "attributes"), "attributes").map(jsonKeyValue),
      traceId: idBytes(get(o, "traceId", "trace_id"), "traceId"),
      spanId: idBytes(get(o, "spanId", "span_id"), "spanId"),
    }),
  );
}

function decodeTracesJSON(root: unknown): ResourceGroup<Span>[] {
  return jsonGroups(
    root,
    ["resourceSpans", "resource_spans"],
    ["scopeSpans", "scope_spans"],
    ["spans", "spans"],
    (o): Span => {
      const st = obj(get(o, "status"), "status");
      return {
        traceId: idBytes(get(o, "traceId", "trace_id"), "traceId"),
        spanId: idBytes(get(o, "spanId", "span_id"), "spanId"),
        parentSpanId: idBytes(get(o, "parentSpanId", "parent_span_id"), "parentSpanId"),
        name: str(get(o, "name"), "name"),
        kind: enumValue(get(o, "kind"), SPAN_KIND_NAMES, "kind"),
        startTimeUnixNano: int64(get(o, "startTimeUnixNano", "start_time_unix_nano"), "startTimeUnixNano", true),
        endTimeUnixNano: int64(get(o, "endTimeUnixNano", "end_time_unix_nano"), "endTimeUnixNano", true),
        attributes: arr(get(o, "attributes"), "attributes").map(jsonKeyValue),
        status: st
          ? {
              code: enumValue(get(st, "code"), STATUS_CODE_NAMES, "status.code"),
              message: str(get(st, "message"), "status.message"),
            }
          : undefined,
      };
    },
  );
}
