// --- v2 read API on Basin (refs #163) ---
//
// `/api/v1/query` (raw SQL) and `/api/v1/logs` (structured search), and the
// reads behind the MCP tools. Every read goes to Basin SQL; ClickHouse is not
// reachable from here.

import {
  BasinQueryError,
  propNumber,
  propString,
  queryBasin,
  sqlString,
  type BasinSqlEnv,
} from "./basin-sql";

export const MAX_QUERY_ROWS = 10_000;
export const MAX_SEARCH_LIMIT = 1000;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_HOURS = 720;
export const MAX_SOURCES = 20;

// --- Raw SQL ---

export class QueryRejected extends Error {
  override name = "QueryRejected";
}

/**
 * Normalise a caller's SQL: strip a trailing `;`, require a read statement,
 * and cap the rows when the caller set no LIMIT. Basin is read-only anyway;
 * the SELECT check is there to give a clear error instead of Basin's.
 */
export function prepareQuery(sql: unknown): string {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new QueryRejected("SQL query is required");
  }
  const body = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(body)) {
    throw new QueryRejected("Only SELECT statements are allowed");
  }
  // On its own line, so a trailing `-- comment` can't swallow it.
  return /\blimit\s+\d+/i.test(body) ? body : `${body}\nLIMIT ${MAX_QUERY_ROWS}`;
}

/**
 * ClickHouse spellings the v1 API accepted that Basin (DataFusion) doesn't.
 * Only consulted after Basin has already rejected a query, to say what to
 * write instead. No rewriting: callers move to the new dialect once.
 */
const CLICKHOUSE_HINTS: [RegExp, string][] = [
  [/\bcountIf\s*\(/i, "countIf(x) → count(*) FILTER (WHERE x)"],
  [/\buniqExactIf\s*\(|\buniqIf\s*\(/i, "uniqExactIf(x, c) → count(DISTINCT x) FILTER (WHERE c)"],
  [/\buniqExact\s*\(|\buniq\s*\(/i, "uniqExact(x) → count(DISTINCT x)"],
  [/\btoStartOf(Minute|Hour|Day|Week|Month)\s*\(/i, "toStartOfHour(ts) → date_trunc('hour', ts)"],
  [/\bJSONExtract\w*\s*\(/i, "JSONExtractString(properties, 'k') → json_get_str(properties, 'k'); numbers: json_get_float / json_get_int"],
  [/\bformatDateTime\s*\(/i, "formatDateTime(...) → to_char(ts, '%Y-%m-%d %H:%M:%S')"],
  [/\b(toDateTime|toDateTime64|parseDateTimeBestEffort)\s*\(/i, "toDateTime('…') → TIMESTAMP '2026-10-23T12:00:00Z' (or compare ts to an ISO string)"],
  [/\bINTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY)S?\b/i, "INTERVAL 1 HOUR → INTERVAL '1 hour'"],
  [/\bany\s*\(/i, "any(x) → min(x) or first_value(x)"],
  [/\bFORMAT\s+\w+\s*$/i, "drop FORMAT …; the API always returns JSON"],
  [/\btimestamp\b(?!\s*')/i, "the event time column is ts (received_at is when it was accepted)"],
];

export function dialectHints(sql: string): string[] {
  return CLICKHOUSE_HINTS.filter(([re]) => re.test(sql)).map(([, hint]) => hint);
}

// --- Structured search ---

export type PropertyOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";
const OPERATORS: PropertyOperator[] = ["=", "!=", ">", ">=", "<", "<="];

export interface PropertyFilter {
  key: string;
  value: string;
  operator: PropertyOperator;
}

/** The filters search, stats and their MCP tools share. */
export interface FilterParams {
  /** One source, or several (`source IN (...)`, at most MAX_SOURCES). */
  source?: string | string[];
  level?: string;
  search?: string;
  exception?: string;
  traceId?: string;
  hours?: number;
  /** ISO 8601 or epoch milliseconds. Overrides `hours`. */
  from?: string | number;
  /** ISO 8601 or epoch milliseconds, exclusive. Defaults to now. */
  to?: string | number;
  propertyFilters?: PropertyFilter[];
}

export interface SearchParams extends FilterParams {
  limit?: number;
  order?: string;
  cursor?: string;
}

/** `prop.Key=>5` style values, as v1 accepted them. */
export function parseOperatorFromValue(raw: string): { operator: PropertyOperator; value: string } {
  for (const op of [">=", "<=", "!=", ">", "<"] as const) {
    if (raw.startsWith(op)) return { operator: op, value: raw.slice(op.length) };
  }
  return { operator: "=", value: raw };
}

export function isOperator(op: unknown): op is PropertyOperator {
  return typeof op === "string" && (OPERATORS as string[]).includes(op);
}

function isNumeric(v: string): boolean {
  return v.trim() !== "" && Number.isFinite(Number(v));
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

function propertyCondition(f: PropertyFilter): string {
  const path = f.key.split(".").filter((p) => p !== "");
  if (path.length === 0) throw new QueryRejected("Property filter key is empty");
  if (isNumeric(f.value)) {
    return `${propNumber(path)} ${f.operator} ${Number(f.value)}`;
  }
  // Ordering a string makes no sense; v1 treated anything but != as =.
  const op = f.operator === "!=" ? "!=" : "=";
  return `${propString(path)} ${op} ${sqlString(f.value)}`;
}

export const SEARCH_COLUMNS =
  "id, ts, level, message, message_template, exception, event_type, source, kind, trace_id, span_id, parent_span_id, duration_ms, properties";

/**
 * `ts` as Basin prints it, at full precision, for cursors and context
 * windows. Read back as text so a cursor names the exact instant the row
 * carries; stripped before rows go to callers.
 */
const CURSOR_TS = "CAST(ts AS VARCHAR) AS cursor_ts";

// --- Time windows ---

const HOUR_MS = 3_600_000;
/** Year 10000: past it toISOString() grows a sign and stops being a literal. */
const MAX_INSTANT_MS = 253_402_300_800_000;

/** A caller's `from` / `to` / `ts`: ISO 8601 or epoch milliseconds. */
export function parseInstant(raw: string | number, name: string): Date {
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (/^\d+$/.test(s)) ms = Number(s);
    else if (/^\d{4}-\d{2}-\d{2}/.test(s)) ms = Date.parse(s);
  }
  if (!Number.isFinite(ms) || ms < 0 || ms >= MAX_INSTANT_MS) {
    throw new QueryRejected(`${name} must be an ISO 8601 time or epoch milliseconds`);
  }
  return new Date(Math.trunc(ms));
}

/** A DataFusion timestamp literal, millisecond precision, UTC. */
export function instantLiteral(at: Date): string {
  return `TIMESTAMP '${at.toISOString()}'`;
}

/**
 * The time predicate. With neither `from` nor `to` it is today's relative
 * window, unchanged. Otherwise the window is [from, to): `from` overrides
 * `hours`, `to` defaults to now (no upper bound in the SQL, as with `hours`),
 * and a window over MAX_SEARCH_HOURS is refused rather than cut, so a caller
 * never reads a shorter window than they asked for without knowing.
 */
function windowConditions(p: FilterParams, now: Date): string[] {
  const hours = clampInt(p.hours, 24, 1, MAX_SEARCH_HOURS);
  if (p.from === undefined && p.to === undefined) return [`ts > now() - INTERVAL '${hours} hours'`];
  const to = p.to === undefined ? undefined : parseInstant(p.to, "to");
  const end = to ?? now;
  const from = p.from === undefined ? new Date(end.getTime() - hours * HOUR_MS) : parseInstant(p.from, "from");
  if (from.getTime() >= end.getTime()) throw new QueryRejected("from must be before to (default now)");
  if (end.getTime() - from.getTime() > MAX_SEARCH_HOURS * HOUR_MS) {
    throw new QueryRejected(`The window from ${from.toISOString()} to ${end.toISOString()} is over ${MAX_SEARCH_HOURS} hours`);
  }
  const out = [`ts >= ${instantLiteral(from)}`];
  if (to) out.push(`ts < ${instantLiteral(to)}`);
  return out;
}

/** The WHERE terms search and stats share. Every value goes through sqlString or a number. */
export function filterConditions(p: FilterParams, now = new Date()): string[] {
  const where = windowConditions(p, now);
  const sources = [...new Set(typeof p.source === "string" ? [p.source] : (p.source ?? []))].filter((s) => s !== "");
  if (sources.length > MAX_SOURCES) throw new QueryRejected(`source takes at most ${MAX_SOURCES} values`);
  if (sources.length === 1) where.push(`source = ${sqlString(sources[0])}`);
  else if (sources.length > 1) where.push(`source IN (${sources.map(sqlString).join(", ")})`);
  if (p.level) where.push(`level = ${sqlString(p.level)}`);
  // strpos, not LIKE: a % or _ in the search text is literal. It is also a
  // function call, so Basin can't prune on it (#187).
  if (p.search) where.push(`strpos(message, ${sqlString(p.search)}) > 0`);
  if (p.exception) where.push(`strpos(exception, ${sqlString(p.exception)}) > 0`);
  if (p.traceId) where.push(`trace_id = ${sqlString(p.traceId)}`);
  for (const f of p.propertyFilters ?? []) where.push(propertyCondition(f));
  return where;
}

// --- Paging ---

export type Order = "asc" | "desc";

export function parseOrder(v: unknown): Order {
  if (v === undefined || v === null || v === "") return "desc";
  if (v === "asc" || v === "desc") return v;
  throw new QueryRejected("order must be asc or desc");
}

/** What Basin prints for a naive timestamp cast to text. Anything else in a cursor is refused. */
const CURSOR_TS_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;

export interface Cursor {
  order: Order;
  ts: string;
  id: string;
}

function base64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Opaque to callers: base64url of `order|ts|id`. */
export function encodeCursor(c: Cursor): string {
  return base64url(`${c.order}|${c.ts}|${c.id}`);
}

export function decodeCursor(s: string): Cursor {
  let text: string;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    throw new QueryRejected("cursor is not one this API issued");
  }
  // The id is last and may itself contain "|"; order and ts never do.
  const [order, ts, ...rest] = text.split("|");
  const id = rest.join("|");
  if ((order !== "asc" && order !== "desc") || !CURSOR_TS_TEXT.test(ts ?? "") || rest.length === 0 || id === "") {
    throw new QueryRejected("cursor is not one this API issued");
  }
  return { order, ts, id };
}

/**
 * Rows after the cursor in the page order, keyed on (ts, id) so rows sharing
 * a timestamp are neither skipped nor repeated.
 *
 * The `ts` comparisons do the window work. `ts` is a timestamp column, which
 * #187 doesn't affect, so files wholly past the cursor are pruned correctly.
 * `id` is a string column from the same writers as the columns #187 names,
 * so a bare range filter on it could prune away a file that holds the next
 * rows. Here it only appears ANDed with `ts = <cursor ts>`, inside an OR
 * whose other arm is the plain ts range. A file whose ts range reaches past
 * the cursor instant matches the ts arm and can't be pruned on id at all; the
 * only file a bad id bound could drop is one whose rows all sit at or beyond
 * the cursor instant with its first row exactly at it, and only rows at that
 * one instant. That is the narrowest exposure an (ts, id) key can have, and
 * the hourly bound repair (#187) closes it for data over an hour old.
 */
function cursorCondition(c: Cursor): string {
  const ts = `TIMESTAMP ${sqlString(c.ts)}`;
  const cmp = c.order === "asc" ? ">" : "<";
  return `(ts ${cmp} ${ts} OR (ts = ${ts} AND id ${cmp} ${sqlString(c.id)}))`;
}

export function buildSearchSql(p: SearchParams, now = new Date()): string {
  const limit = clampInt(p.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const order = parseOrder(p.order);
  const where = filterConditions(p, now);
  if (p.cursor) {
    const cursor = decodeCursor(p.cursor);
    if (cursor.order !== order) throw new QueryRejected(`cursor was issued for order=${cursor.order}`);
    where.push(cursorCondition(cursor));
  }
  const dir = order.toUpperCase();
  return `SELECT ${SEARCH_COLUMNS}, ${CURSOR_TS} FROM logs.events WHERE ${where.join(" AND ")} ORDER BY ts ${dir}, id ${dir} LIMIT ${limit}`;
}

export interface LogOut {
  id: string;
  ts: string;
  level: string;
  message: string;
  message_template: string;
  source: string;
  event_type?: string;
  exception?: string;
  kind?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  properties: unknown;
}

function parseProperties(p: unknown): unknown {
  if (typeof p !== "string") return p ?? {};
  try {
    return JSON.parse(p);
  } catch {
    return p;
  }
}

/** Shape a search row for callers: drop empty optional fields and cursor_ts, parse properties. */
export function toLogOut(r: Record<string, unknown>): LogOut {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "properties" || k === "cursor_ts") continue;
    if (v === null || v === undefined || v === "") continue;
    if (k === "kind" && v === "log") continue;
    out[k] = v;
  }
  out.properties = parseProperties(r.properties);
  return out as unknown as LogOut;
}

export async function searchLogs(env: BasinSqlEnv, p: SearchParams) {
  const sql = buildSearchSql(p);
  const limit = clampInt(p.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const order = parseOrder(p.order);
  const { rows, bytesScanned } = await queryBasin(env, sql);
  const meta: Record<string, unknown> = { count: rows.length, limit, order, bytes_scanned: bytesScanned };
  const last = rows.at(-1);
  if (rows.length === limit && last && typeof last.cursor_ts === "string" && typeof last.id === "string") {
    meta.next_cursor = encodeCursor({ order, ts: last.cursor_ts, id: last.id });
  }
  return { data: rows.map(toLogOut), meta };
}

/** Repeated `prop.<key>=<value>` parameters, as v1 accepted them. */
function filterParamsFromUrl(q: URLSearchParams): FilterParams {
  const propertyFilters: PropertyFilter[] = [];
  for (const [k, v] of q.entries()) {
    if (k.startsWith("prop.")) propertyFilters.push({ key: k.slice(5), ...parseOperatorFromValue(v) });
  }
  return {
    // Comma-separated for several sources.
    source: listParam(q.get("source")),
    level: q.get("level") || undefined,
    search: q.get("search") || undefined,
    exception: q.get("exception") || undefined,
    traceId: q.get("trace_id") || undefined,
    hours: intParam(q, "hours"),
    from: q.get("from") || undefined,
    to: q.get("to") || undefined,
    propertyFilters,
  };
}

function intParam(q: URLSearchParams, k: string): number | undefined {
  return q.has(k) ? Number.parseInt(q.get(k)!, 10) : undefined;
}

export function searchParamsFromUrl(url: URL): SearchParams {
  const q = url.searchParams;
  return {
    ...filterParamsFromUrl(q),
    limit: intParam(q, "limit"),
    order: q.get("order") || undefined,
    cursor: q.get("cursor") || undefined,
  };
}

// --- Stats (GET /api/v1/stats, MCP log_stats) ---

export const MAX_STATS_LIMIT = 10_000;
export const DEFAULT_STATS_LIMIT = 100;
export const MAX_GROUP_BY = 2;
const GROUP_COLUMNS = ["source", "level", "message_template", "event_type"];
const BUCKETS: Record<string, string> = {
  minute: "date_trunc('minute', ts)",
  "5m": "date_bin(INTERVAL '5 minutes', ts, TIMESTAMP '1970-01-01T00:00:00')",
  "15m": "date_bin(INTERVAL '15 minutes', ts, TIMESTAMP '1970-01-01T00:00:00')",
  hour: "date_trunc('hour', ts)",
  day: "date_trunc('day', ts)",
};

export interface StatsParams extends FilterParams {
  groupBy?: string[];
  bucket?: string;
  limit?: number;
}

/** A group key as SQL: a column, or `prop:<key>` read through the guarded property helper. */
function groupExpression(g: string): string {
  if (GROUP_COLUMNS.includes(g)) return g;
  if (g.startsWith("prop:")) {
    const path = g.slice(5).split(".").filter((p) => p !== "");
    if (path.length === 0) throw new QueryRejected("group_by prop: needs a key");
    // Oversized properties read as NULL here (or via the top-level regex),
    // never as a json_get over the 2000-byte cap that would fail the query.
    return propString(path);
  }
  throw new QueryRejected(`group_by must be one of ${GROUP_COLUMNS.join(", ")} or prop:<key>`);
}

/**
 * Counts grouped and bucketed. Group keys are aliased g0/g1 and renamed in
 * `getStats`, so a `prop:<key>` name never has to become a SQL identifier.
 */
export function buildStatsSql(p: StatsParams, now = new Date()): string {
  const groups = p.groupBy ?? [];
  if (groups.length > MAX_GROUP_BY) throw new QueryRejected(`group_by takes at most ${MAX_GROUP_BY} keys`);
  if (new Set(groups).size !== groups.length) throw new QueryRejected("group_by repeats a key");
  if (p.bucket !== undefined && !(p.bucket in BUCKETS)) {
    throw new QueryRejected(`bucket must be one of ${Object.keys(BUCKETS).join(", ")}`);
  }
  const limit = clampInt(p.limit, DEFAULT_STATS_LIMIT, 1, MAX_STATS_LIMIT);
  const keys = groups.map(groupExpression);
  const select: string[] = [];
  const groupBy: string[] = [];
  if (p.bucket) {
    select.push(`${BUCKETS[p.bucket]} AS bucket`);
    groupBy.push(BUCKETS[p.bucket]);
  }
  keys.forEach((k, i) => {
    select.push(`${k} AS g${i}`);
    groupBy.push(k);
  });
  // Delivery is at-least-once, so `unique` (distinct ids) sits beside count.
  select.push("count(*) AS count", 'count(DISTINCT id) AS "unique"');
  const orderBy = p.bucket ? "bucket ASC, count DESC" : "count DESC";
  return (
    `SELECT ${select.join(", ")} FROM logs.events WHERE ${filterConditions(p, now).join(" AND ")}` +
    (groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : "") +
    ` ORDER BY ${orderBy} LIMIT ${limit}`
  );
}

export async function getStats(env: BasinSqlEnv, p: StatsParams) {
  const sql = buildStatsSql(p);
  const groups = p.groupBy ?? [];
  const { rows, bytesScanned } = await queryBasin(env, sql);
  const data = rows.map((r) => {
    const out: Record<string, unknown> = {};
    groups.forEach((g, i) => (out[g] = r[`g${i}`] ?? null));
    if (p.bucket) out.bucket = r.bucket;
    out.count = Number(r.count);
    out.unique = Number(r.unique);
    return out;
  });
  return {
    data,
    meta: { rows: data.length, limit: clampInt(p.limit, DEFAULT_STATS_LIMIT, 1, MAX_STATS_LIMIT), bytes_scanned: bytesScanned },
  };
}

/** Comma-separated on REST. */
function listParam(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return items.length ? items : undefined;
}

export function statsParamsFromUrl(url: URL): StatsParams {
  const q = url.searchParams;
  return {
    ...filterParamsFromUrl(q),
    groupBy: listParam(q.get("group_by")),
    bucket: q.get("bucket") || undefined,
    limit: intParam(q, "limit"),
  };
}

// --- One event and its context (GET /api/v1/events/{id}, MCP get_event) ---

export const EVENT_TS_SLACK_MINUTES = 10;
export const DEFAULT_EVENT_HOURS = 24;
export const DEFAULT_CONTEXT_LIMIT = 200;
export const MAX_CONTEXT_LIMIT = 1000;
/** A context window reaches at most a day either side of the event. */
export const MAX_CONTEXT_MINUTES = 1440;

export interface EventParams {
  id: string;
  /** Narrows the lookup to ±10 minutes around this instant. */
  ts?: string | number;
  hours?: number;
  context?: string;
  beforeMinutes?: number;
  afterMinutes?: number;
  limit?: number;
}

/**
 * Find one row by id. `id` is a string column from the same writers #187
 * names, so `id = '…'` could be pruned away; `strpos` is a function call and
 * can't prune. Matching the length as well makes the predicate exact, and the
 * caller still checks equality on the rows that come back. The ts window
 * bounds the scan.
 */
export function buildEventLookupSql(p: EventParams, now = new Date()): string {
  if (!p.id) throw new QueryRejected("id is required");
  let window: string;
  if (p.ts !== undefined) {
    const at = parseInstant(p.ts, "ts");
    const slack = EVENT_TS_SLACK_MINUTES * 60_000;
    window = `ts >= ${instantLiteral(new Date(at.getTime() - slack))} AND ts <= ${instantLiteral(new Date(at.getTime() + slack))}`;
  } else {
    window = windowConditions({ hours: p.hours ?? DEFAULT_EVENT_HOURS }, now).join(" AND ");
  }
  const bytes = new TextEncoder().encode(p.id).byteLength;
  return (
    `SELECT ${SEARCH_COLUMNS}, ${CURSOR_TS} FROM logs.events WHERE ${window} ` +
    `AND strpos(id, ${sqlString(p.id)}) > 0 AND octet_length(id) = ${bytes} ORDER BY ts ASC LIMIT 10`
  );
}

export type ContextKind = "source" | "trace";

export function parseContext(v: unknown): ContextKind | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "source" || v === "trace") return v;
  throw new QueryRejected("context must be source or trace");
}

/**
 * The rows around an event, in time order: the same source, or the same
 * trace, from `before_minutes` before it to `after_minutes` after it. The
 * window is built on the event's own ts text, so it is exact.
 */
export function buildContextSql(
  event: { ts: string; source?: unknown; trace_id?: unknown },
  p: EventParams,
): string | null {
  const kind = parseContext(p.context);
  if (!kind) return null;
  if (!CURSOR_TS_TEXT.test(event.ts)) throw new Error(`unexpected ts text from Basin: ${event.ts}`);
  const before = clampInt(p.beforeMinutes, 5, 0, MAX_CONTEXT_MINUTES);
  const after = clampInt(p.afterMinutes, 1, 0, MAX_CONTEXT_MINUTES);
  const limit = clampInt(p.limit, DEFAULT_CONTEXT_LIMIT, 1, MAX_CONTEXT_LIMIT);
  const at = `TIMESTAMP ${sqlString(event.ts)}`;
  const where = [`ts >= ${at} - INTERVAL '${before} minutes'`, `ts <= ${at} + INTERVAL '${after} minutes'`];
  const key = kind === "source" ? event.source : event.trace_id;
  if (typeof key !== "string" || key === "") return null;
  where.push(kind === "source" ? `source = ${sqlString(key)}` : `trace_id = ${sqlString(key)}`);
  return `SELECT ${SEARCH_COLUMNS} FROM logs.events WHERE ${where.join(" AND ")} ORDER BY ts ASC, id ASC LIMIT ${limit}`;
}

/** The event, or null when no row in the window carries exactly this id. */
export async function getEvent(env: BasinSqlEnv, p: EventParams) {
  // Validate everything before the first query, so a bad context param is a
  // 400 rather than a 400 after a lookup.
  const kind = parseContext(p.context);
  const lookup = buildEventLookupSql(p);
  const found = await queryBasin(env, lookup);
  const row = found.rows.find((r) => r.id === p.id);
  if (!row) return null;
  const meta: Record<string, unknown> = { bytes_scanned: found.bytesScanned };
  const out: { data: LogOut; context?: LogOut[]; meta: Record<string, unknown> } = { data: toLogOut(row), meta };
  if (kind) {
    const sql = buildContextSql({ ts: String(row.cursor_ts ?? ""), source: row.source, trace_id: row.trace_id }, p);
    if (sql) {
      const ctx = await queryBasin(env, sql);
      out.context = ctx.rows.map(toLogOut);
      meta.bytes_scanned = found.bytesScanned + ctx.bytesScanned;
      meta.context = {
        kind,
        before_minutes: clampInt(p.beforeMinutes, 5, 0, MAX_CONTEXT_MINUTES),
        after_minutes: clampInt(p.afterMinutes, 1, 0, MAX_CONTEXT_MINUTES),
        count: ctx.rows.length,
        limit: clampInt(p.limit, DEFAULT_CONTEXT_LIMIT, 1, MAX_CONTEXT_LIMIT),
      };
    } else {
      out.context = [];
      meta.context = { kind, count: 0, note: kind === "trace" ? "The event has no trace_id" : "The event has no source" };
    }
  }
  return out;
}

export function eventParamsFromUrl(id: string, url: URL): EventParams {
  const q = url.searchParams;
  return {
    id,
    ts: q.get("ts") || undefined,
    hours: intParam(q, "hours"),
    context: q.get("context") || undefined,
    beforeMinutes: intParam(q, "before_minutes"),
    afterMinutes: intParam(q, "after_minutes"),
    limit: intParam(q, "limit"),
  };
}

// --- Overview (MCP get_overview) ---

/**
 * Basin is 1–2 minutes behind (60 s sink roll plus commit). Rates are taken
 * over a window that ends this far back, so "per minute" isn't read off a
 * minute that hasn't landed yet.
 */
export const FLUSH_LAG_MINUTES = 3;
const ERROR_LEVELS = "('Error', 'Fatal')";

export async function getOverview(env: BasinSqlEnv) {
  const window = "ts > now() - INTERVAL '24 hours'";
  const recent = `ts > now() - INTERVAL '${FLUSH_LAG_MINUTES + 10} minutes' AND ts <= now() - INTERVAL '${FLUSH_LAG_MINUTES} minutes'`;
  const [metrics, services, topErrors] = await Promise.all([
    queryBasin(
      env,
      `SELECT count(*) FILTER (WHERE ${recent}) / 10.0 AS logs_per_minute, count(*) AS total_logs_24h, ` +
        `count(*) FILTER (WHERE level IN ${ERROR_LEVELS}) AS total_errors_24h, ` +
        `count(DISTINCT source) AS active_services, ` +
        `count(DISTINCT source) FILTER (WHERE level IN ${ERROR_LEVELS}) AS services_with_errors ` +
        `FROM logs.events WHERE ${window}`,
    ),
    queryBasin(
      env,
      `SELECT source, count(*) AS total_count, count(*) FILTER (WHERE level IN ${ERROR_LEVELS}) AS error_count, ` +
        `max(ts) AS last_log FROM logs.events WHERE ${window} GROUP BY source ORDER BY total_count DESC`,
    ),
    queryBasin(
      env,
      `SELECT message_template, level, count(*) AS count, max(ts) AS latest_ts, min(message) AS sample_message ` +
        `FROM logs.events WHERE ${window} AND level IN ('Error', 'Fatal', 'Warning') ` +
        `GROUP BY message_template, level ORDER BY count DESC LIMIT 10`,
    ),
  ]);
  const m = (metrics.rows[0] ?? {}) as Record<string, number>;
  const total = Number(m.total_logs_24h ?? 0);
  const errors = Number(m.total_errors_24h ?? 0);
  return {
    metrics: {
      ...m,
      error_rate_24h: total > 0 ? Math.round((errors * 10000) / total) / 100 : 0,
      lag_note: `Basin is 1-2 minutes behind; logs_per_minute averages the 10 minutes ending ${FLUSH_LAG_MINUTES} minutes ago.`,
    },
    services: services.rows,
    top_errors: topErrors.rows,
  };
}

/** Live facts for get_docs("overview"): sources, levels and property keys seen recently. */
export async function getLiveFacts(env: BasinSqlEnv) {
  const [sources, levels, sample] = await Promise.all([
    queryBasin<{ source: string; n: number }>(
      env,
      "SELECT source, count(*) AS n FROM logs.events WHERE ts > now() - INTERVAL '24 hours' GROUP BY source ORDER BY n DESC",
    ),
    queryBasin<{ level: string }>(
      env,
      "SELECT DISTINCT level FROM logs.events WHERE ts > now() - INTERVAL '24 hours' ORDER BY level",
    ),
    queryBasin<{ properties: string }>(
      env,
      "SELECT properties FROM logs.events WHERE ts > now() - INTERVAL '1 hour' ORDER BY ts DESC LIMIT 500",
    ),
  ]);
  const keys = new Map<string, string>();
  for (const r of sample.rows) {
    const p = parseProperties(r.properties);
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    for (const [k, v] of Object.entries(p)) {
      if (keys.size >= 60) break;
      if (!keys.has(k)) keys.set(k, typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40));
    }
  }
  return {
    sources: sources.rows.map((r) => r.source),
    levels: levels.rows.map((r) => r.level),
    propertyKeys: [...keys].map(([key, sampleValue]) => ({ key, sampleValue })),
  };
}

export { BasinQueryError };
