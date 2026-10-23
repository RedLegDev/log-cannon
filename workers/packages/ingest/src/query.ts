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

export interface SearchParams {
  source?: string;
  level?: string;
  search?: string;
  traceId?: string;
  hours?: number;
  limit?: number;
  propertyFilters?: PropertyFilter[];
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

export function buildSearchSql(p: SearchParams): string {
  const hours = clampInt(p.hours, 24, 1, MAX_SEARCH_HOURS);
  const limit = clampInt(p.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const where = [`ts > now() - INTERVAL '${hours} hours'`];
  if (p.source) where.push(`source = ${sqlString(p.source)}`);
  if (p.level) where.push(`level = ${sqlString(p.level)}`);
  // strpos, not LIKE: a % or _ in the search text is literal.
  if (p.search) where.push(`strpos(message, ${sqlString(p.search)}) > 0`);
  if (p.traceId) where.push(`trace_id = ${sqlString(p.traceId)}`);
  for (const f of p.propertyFilters ?? []) where.push(propertyCondition(f));
  return `SELECT ${SEARCH_COLUMNS} FROM logs.events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`;
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

/** Shape a search row for callers: drop empty optional fields, parse properties. */
export function toLogOut(r: Record<string, unknown>): LogOut {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "properties") continue;
    if (v === null || v === undefined || v === "") continue;
    if (k === "kind" && v === "log") continue;
    out[k] = v;
  }
  out.properties = parseProperties(r.properties);
  return out as unknown as LogOut;
}

export async function searchLogs(env: BasinSqlEnv, p: SearchParams) {
  const sql = buildSearchSql(p);
  const { rows, bytesScanned } = await queryBasin(env, sql);
  return {
    data: rows.map(toLogOut),
    meta: { count: rows.length, limit: clampInt(p.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT), bytes_scanned: bytesScanned },
  };
}

export function searchParamsFromUrl(url: URL): SearchParams {
  const q = url.searchParams;
  const num = (k: string) => (q.has(k) ? Number.parseInt(q.get(k)!, 10) : undefined);
  const propertyFilters: PropertyFilter[] = [];
  for (const [k, v] of q.entries()) {
    if (k.startsWith("prop.")) propertyFilters.push({ key: k.slice(5), ...parseOperatorFromValue(v) });
  }
  return {
    source: q.get("source") || undefined,
    level: q.get("level") || undefined,
    search: q.get("search") || undefined,
    traceId: q.get("trace_id") || undefined,
    hours: num("hours"),
    limit: num("limit"),
    propertyFilters,
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
