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
    readonly status: 400 | 502 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}

export const BASIN_QUERY_TIMEOUT_MS = 30_000;

interface BasinResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { rows?: unknown[]; metrics?: { bytes_scanned?: number } };
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
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new BasinQueryError(504, `Query exceeded ${timeoutMs / 1000} seconds`);
    }
    throw new BasinQueryError(502, "Basin SQL unreachable");
  }

  let body: BasinResponse;
  try {
    body = (await res.json()) as BasinResponse;
  } catch {
    throw new BasinQueryError(502, `Basin SQL returned ${res.status} with a non-JSON body`);
  }

  if (!body.success) {
    const err = body.errors?.[0];
    const message = err?.message ?? `Basin SQL returned ${res.status}`;
    // Basin reports the caller's mistakes as 4xxxx codes (invalid SQL,
    // unknown column, argument limits). Everything else is on our side.
    const callerError =
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) ||
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
 * only, and string values only when they contain no escapes.
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
      ? `CAST((regexp_match(properties, ${sqlString(`${keyPattern(path[0])}:"?(-?[0-9][0-9.eE+-]*)`)}))[1] AS DOUBLE)`
      : "NULL";
  return `CASE WHEN ${SMALL} THEN ${small} ELSE ${large} END`;
}
