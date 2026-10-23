// The Supabase Management API logs endpoint (refs #164). A port of
// supabase-pull's supabase.go with the Worker's bounds: a 429 ends the table
// for this tick instead of sleeping on Retry-After, and a transient failure
// gets one short retry instead of two.
//
// Times are epoch microseconds throughout. Supabase stamps rows in
// microseconds, and a keyset cursor rounded to milliseconds would re-read or
// skip rows that share a millisecond.

/** One row of the Supabase unified logs stream. */
export interface Row {
  id: string;
  tsUs: number;
  message: string;
  severity: string;
  attributes: Record<string, unknown>;
}

/**
 * A keyset position: the next page holds rows strictly after (tsUs, id). An
 * empty id means "from tsUs inclusive". Keying on the id as well as the
 * timestamp is what lets a page boundary fall inside a run of equal
 * timestamps (auth_logs stamps whole seconds) without looping or skipping.
 */
export interface Cursor {
  tsUs: number;
  id: string;
}

export const DEFAULT_API_URL = "https://api.supabase.com";

/** Under the endpoint's 24-hour cap on iso_timestamp_start..iso_timestamp_end. */
export const MAX_QUERY_WINDOW_US = 23 * 3600 * 1e6;
export const REQUEST_TIMEOUT_MS = 30_000;
export const TRANSIENT_WAIT_MS = 2_000;

/** A PAT the API refused. Not transient, so it is reported separately. */
export class AuthError extends Error {
  override name = "AuthError";
}

/** A 429. The table stops for this tick and its cursor stays where it was. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
}

/** The endpoint's own "Backend error! Retry your query", which arrives as
 * HTTP 200 with an error body and clears on retry. Retried like a 5xx. */
export class BackendError extends Error {
  override name = "BackendError";
}

export interface ApiClient {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `YYYY-MM-DD HH:MM:SS.ffffff`, UTC: what toDateTime64(…, 6) reads. */
export function sqlTimestamp(us: number): string {
  const ms = Math.floor(us / 1000);
  const d = new Date(ms);
  const frac = us - Math.floor(us / 1e6) * 1e6;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(frac, 6)}`
  );
}

/** Whole-second ISO, the granularity the iso_timestamp_* params take. */
function isoSeconds(us: number): string {
  return new Date(Math.floor(us / 1e6) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sqlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildSQL(table: string, cur: Cursor, limit: number): string {
  const ts = `toDateTime64('${sqlTimestamp(cur.tsUs)}', 6, 'UTC')`;
  const where = cur.id
    ? `(timestamp > ${ts} OR (timestamp = ${ts} AND id > '${sqlEscape(cur.id)}'))`
    : `timestamp >= ${ts}`;
  return (
    "SELECT id, timestamp, event_message, severity_text, log_attributes FROM logs " +
    `WHERE source = '${sqlEscape(table)}' AND ${where} ORDER BY timestamp ASC, id ASC LIMIT ${limit}`
  );
}

export function queryUrl(baseUrl: string, ref: string, table: string, cur: Cursor, fromUs: number, toUs: number, limit: number): string {
  const params = new URLSearchParams({
    sql: buildSQL(table, cur, limit),
    iso_timestamp_start: isoSeconds(fromUs),
    // Rounded up, so the window still covers `to`.
    iso_timestamp_end: isoSeconds(Math.ceil(toUs / 1e6) * 1e6),
  });
  return `${baseUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/logs?${params}`;
}

/**
 * Up to `limit` rows of `table` after `cur`, inside [fromUs, toUs], ordered by
 * (timestamp, id).
 */
export async function queryLogs(
  api: ApiClient,
  ref: string,
  table: string,
  cur: Cursor,
  fromUs: number,
  toUs: number,
  limit: number,
): Promise<Row[]> {
  const url = queryUrl(api.baseUrl, ref, table, cur, fromUs, toUs, limit);
  for (let attempt = 0; ; attempt++) {
    const retry = attempt === 0;
    let resp: Response;
    try {
      resp = await api.fetch(url, {
        headers: { Authorization: `Bearer ${api.token}`, "User-Agent": "log-cannon-supabase-pull/2.0" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (!retry) throw e;
      await api.sleep(TRANSIENT_WAIT_MS);
      continue;
    }
    const body = await resp.text();
    if (resp.status === 429) throw new RateLimitedError(`supabase logs API rate limit (HTTP 429): ${snippet(body)}`);
    if (resp.status >= 500 && retry) {
      await api.sleep(TRANSIENT_WAIT_MS);
      continue;
    }
    try {
      return checkResponse(resp.status, body);
    } catch (e) {
      if (!(e instanceof BackendError) || !retry) throw e;
      await api.sleep(TRANSIENT_WAIT_MS);
    }
  }
}

function checkResponse(status: number, body: string): Row[] {
  if (status === 401 || status === 403) throw new AuthError(`supabase rejected the access token (HTTP ${status})`);
  if (status < 200 || status >= 300) throw new Error(`supabase logs API returned HTTP ${status}: ${snippet(body)}`);
  return parseResponse(body);
}

export function parseResponse(body: string): Row[] {
  let resp: { result?: unknown; error?: unknown };
  try {
    resp = JSON.parse(body);
  } catch (e) {
    throw new Error(`decode supabase logs response: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (resp.error !== null && resp.error !== undefined) {
    const s = JSON.stringify(resp.error);
    if (s.includes("Retry your query")) throw new BackendError(`supabase logs backend error: ${snippet(s)}`);
    throw new Error(`supabase logs API error: ${snippet(s)}`);
  }
  const result = Array.isArray(resp.result) ? resp.result : [];
  return result.map((r: Record<string, unknown>) => {
    const id = stringOf(r.id);
    // Without a timestamp or id the row cannot be placed or deduplicated, and
    // skipping it silently would hide a format change. Fail the page.
    if (!id) throw new Error(`row with no id at ${stringOf(r.timestamp)}`);
    let tsUs: number;
    try {
      tsUs = parseTimestamp(r.timestamp);
    } catch (e) {
      throw new Error(`row ${id}: ${(e as Error).message}`);
    }
    const attrs = r.log_attributes;
    return {
      id,
      tsUs,
      message: stringOf(r.event_message),
      severity: stringOf(r.severity_text),
      attributes: attrs && typeof attrs === "object" && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {},
    };
  });
}

const TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/i;

/**
 * Accepts what the endpoint has returned over time: an ISO string,
 * ClickHouse's "YYYY-MM-DD HH:MM:SS.ffffff" (UTC, no zone), or epoch
 * microseconds. Returns epoch microseconds.
 */
export function parseTimestamp(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`bad timestamp ${v}`);
    return v;
  }
  if (typeof v !== "string") throw new Error("missing timestamp");
  const m = TS.exec(v.trim());
  if (!m) throw new Error(`bad timestamp "${v}"`);
  const [, y, mo, d, h, mi, s, frac = "", zone = "Z"] = m;
  const secMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (Number.isNaN(secMs)) throw new Error(`bad timestamp "${v}"`);
  let offsetMin = 0;
  if (zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    offsetMin = sign * (+zone.slice(1, 3) * 60 + +zone.slice(4, 6));
  }
  return (secMs - offsetMin * 60_000) * 1000 + Number(frac.padEnd(6, "0").slice(0, 6));
}

function stringOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function snippet(s: string): string {
  const t = s.trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}
