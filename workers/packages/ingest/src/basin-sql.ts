// --- Basin SQL client (v2 read path, refs #163) ---
//
// Basin SQL has no Worker binding, so reads go over REST with an API token
// held as the `BASIN_SQL_TOKEN` secret. The dialect is Apache DataFusion, and
// the service is read-only, so no statement sent here can change data.

export interface BasinSqlEnv {
  BASIN_SQL_TOKEN?: string;
  BASIN_SQL_ACCOUNT?: string;
  BASIN_SQL_BUCKET?: string;
}

export interface BasinResult<T = Record<string, unknown>> {
  rows: T[];
  bytesScanned: number;
}

/**
 * A query Basin refused (`status` 400: the caller's SQL is wrong) or failed
 * to run (`status` 502/504: retry later). `message` is Basin's own text.
 */
export class BasinQueryError extends Error {
  override name = "BasinQueryError";
  constructor(
    readonly status: 400 | 413 | 502 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}

export const BASIN_QUERY_TIMEOUT_MS = 30_000;

/**
 * Largest Basin response this Worker will hold. Reads share isolates with
 * ingest (128 MB each), and a parsed JSON body costs several times its size,
 * so an unbounded `SELECT properties … LIMIT 10000` could reset an isolate
 * mid-ingest. 5 MB fits 10k rows of narrow columns.
 */
export const MAX_BASIN_RESPONSE_BYTES = 5 * 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw tooLarge(max);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function tooLarge(max: number): BasinQueryError {
  return new BasinQueryError(
    413,
    `Result is over ${max / 1024 / 1024} MB. Select fewer columns (properties is the big one) or lower the LIMIT.`,
  );
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

interface BasinResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { rows?: unknown[]; metrics?: { bytes_scanned?: number } };
}

/** A Basin SQL timestamp cast to VARCHAR, which may or may not carry a zone (UTC either way). */
export function parseBasinTimestamp(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

export async function queryBasin<T = Record<string, unknown>>(
  env: BasinSqlEnv,
  sql: string,
  timeoutMs = BASIN_QUERY_TIMEOUT_MS,
): Promise<BasinResult<T>> {
  const token = env.BASIN_SQL_TOKEN?.trim();
  const account = env.BASIN_SQL_ACCOUNT?.trim();
  const bucket = env.BASIN_SQL_BUCKET?.trim();
  if (!token || !account || !bucket) {
    throw new BasinQueryError(503, "Basin SQL is not configured on this Worker");
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/basin-sql/query/${bucket}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (e) {
    if (isTimeout(e)) throw new BasinQueryError(504, `Query exceeded ${timeoutMs / 1000} seconds`);
    throw new BasinQueryError(502, "Basin SQL unreachable");
  }

  if (res.status === 429) {
    await res.body?.cancel();
    throw new BasinQueryError(503, "Basin SQL is rate limiting; retry shortly");
  }

  let text: string;
  try {
    text = await readCapped(res, MAX_BASIN_RESPONSE_BYTES);
  } catch (e) {
    if (e instanceof BasinQueryError) throw e;
    if (isTimeout(e)) throw new BasinQueryError(504, `Query exceeded ${timeoutMs / 1000} seconds`);
    throw new BasinQueryError(502, "Basin SQL response was cut off");
  }
  let body: BasinResponse;
  try {
    body = JSON.parse(text) as BasinResponse;
  } catch {
    throw new BasinQueryError(502, `Basin SQL returned ${res.status} with a non-JSON body`);
  }

  if (!body.success) {
    const err = body.errors?.[0];
    const message = err?.message ?? `Basin SQL returned ${res.status}`;
    // Basin reports the caller's mistakes as 4xxxx codes (invalid SQL,
    // unknown column, argument limits). Everything else is on our side.
    const callerError =
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) ||
      (err?.code !== undefined && err.code >= 40000 && err.code < 50000);
    throw new BasinQueryError(callerError ? 400 : 502, message);
  }

  return {
    rows: (body.result?.rows ?? []) as T[],
    bytesScanned: body.result?.metrics?.bytes_scanned ?? 0,
  };
}

// --- SQL building ---

/** A DataFusion string literal. Standard SQL: only `'` needs doubling. */
export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Basin rejects the *whole query* when a `json_get_*` argument is over 2000
 * bytes, and ~15% of rows carry larger `properties`. Every generated read of
 * `properties` goes through these guards: JSON functions on rows under the
 * cap, and a regex over the raw text above it. The regex reads top-level keys
 * only by intent: a nested key of the same name can also match. String values
 * match only when they contain no escapes. Numbers go through TRY_CAST, so a
 * value like "1.2.3" reads as NULL instead of failing the query.
 */
export const JSON_ARG_LIMIT = 2000;

const SMALL = `octet_length(properties) <= ${JSON_ARG_LIMIT}`;

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JSON-encoded key as it appears in the stored text, regex-escaped. */
function keyPattern(key: string): string {
  return regexEscape(JSON.stringify(key));
}

function jsonPath(path: string[]): string {
  return path.map(sqlString).join(", ");
}

/** A property as text, or NULL. `path` is a dot-split key. */
export function propString(path: string[]): string {
  const direct = `json_get_str(properties, ${jsonPath(path)})`;
  // A nested path also matches a value that was logged as a JSON string
  // (`"item": "{\"AccountId\": …}"`), as v1 did.
  const small =
    path.length === 1
      ? direct
      : `coalesce(${direct}, json_get_str(json_get_str(properties, ${sqlString(path[0])}), ${jsonPath(path.slice(1))}))`;
  const large =
    path.length === 1
      ? `(regexp_match(properties, ${sqlString(`${keyPattern(path[0])}:"([^"\\\\]*)"`)}))[1]`
      : "NULL";
  return `CASE WHEN ${SMALL} THEN ${small} ELSE ${large} END`;
}

/** A property as a double, or NULL. Numeric strings count, as in v1. */
export function propNumber(path: string[]): string {
  const direct = `json_get_float(properties, ${jsonPath(path)})`;
  const small =
    path.length === 1
      ? direct
      : `coalesce(${direct}, json_get_float(json_get_str(properties, ${sqlString(path[0])}), ${jsonPath(path.slice(1))}))`;
  const large =
    path.length === 1
      ? `TRY_CAST((regexp_match(properties, ${sqlString(`${keyPattern(path[0])}:"?(-?[0-9][0-9.eE+-]*)`)}))[1] AS DOUBLE)`
      : "NULL";
  return `CASE WHEN ${SMALL} THEN ${small} ELSE ${large} END`;
}
