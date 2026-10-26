// --- v2 documentation served by MCP get_docs (refs #163) ---
//
// LOGGER_DOCS is carried over from v1 unchanged: ingest is the same contract.
// The overview and API reference are rewritten for Basin (DataFusion SQL).

export const LOGGER_DOCS = `# Log Cannon - Logger Integration

You are integrating logging into an application that sends logs to Log Cannon.

## Protocol

\`\`\`
POST {LOG_CANNON_URL}/ingest/clef
Headers:
  Content-Type: application/vnd.serilog.clef
  X-Seq-ApiKey: {API_KEY}
Body: Newline-delimited JSON (one event per line)
\`\`\`

## CLEF Format

Each log event is a JSON object:

| Field | Required | Description |
|-------|----------|-------------|
| @t    | Yes      | ISO 8601 timestamp (e.g., 2026-01-25T10:30:00.123Z) |
| @l    | No       | Level: Verbose, Debug, Information, Warning, Error, Fatal (default: Information) |
| @mt   | Yes      | Message template with {Placeholders} for structured logging |
| @i    | No       | Event type identifier. If omitted, auto-computed as MurmurHash3 of @mt (e.g. 0x5432a8ff). Events sharing a template share the same event type. |
| @x    | No       | Exception/stack trace string |
| *     | No       | Any additional properties become searchable fields |

Example events:
\`\`\`json
{"@t":"2026-01-25T10:30:00.123Z","@l":"Information","@mt":"Request {Method} {Path}","Method":"GET","Path":"/api/users"}
{"@t":"2026-01-25T10:30:00.456Z","@l":"Error","@mt":"Database query failed","@x":"Error: Connection timeout\\n    at query()...","QueryDurationMs":5000}
\`\`\`

## Server Logger (TypeScript)

Buffer logs during request handling, flush asynchronously after response using \`waitUntil()\`.

\`\`\`typescript
// lib/logger.ts
interface LoggerConfig {
  url: string;
  apiKey: string;
}

export function createLogger(config: LoggerConfig) {
  const buffer: Array<Record<string, unknown>> = [];

  const log = (level: string, template: string, props?: Record<string, unknown>) => {
    buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...props,
    });
  };

  return {
    verbose: (t: string, p?: Record<string, unknown>) => log('Verbose', t, p),
    debug: (t: string, p?: Record<string, unknown>) => log('Debug', t, p),
    info: (t: string, p?: Record<string, unknown>) => log('Information', t, p),
    warn: (t: string, p?: Record<string, unknown>) => log('Warning', t, p),
    error: (t: string, p?: Record<string, unknown>) => log('Error', t, p),
    fatal: (t: string, p?: Record<string, unknown>) => log('Fatal', t, p),

    // Call at end of request - waitUntil ensures delivery without blocking response
    flush: (ctx: ExecutionContext) => {
      if (buffer.length === 0) return;
      ctx.waitUntil(
        fetch(\`\${config.url}/ingest/clef\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.serilog.clef',
            'X-Seq-ApiKey': config.apiKey,
          },
          body: buffer.map(e => JSON.stringify(e)).join('\\n'),
        }).catch(err => console.error('Log flush failed:', err))
      );
    },
  };
}
\`\`\`

### Server Usage

\`\`\`typescript
// In any request handler with ExecutionContext access
const log = createLogger({
  url: env.LOG_CANNON_URL,
  apiKey: env.LOG_CANNON_API_KEY,
});

log.info('Request started {Method} {Path}', {
  Method: request.method,
  Path: new URL(request.url).pathname,
});

try {
  const result = await handleRequest();
  log.info('Request completed {StatusCode}', { StatusCode: 200 });
  log.flush(ctx);
  return Response.json(result);
} catch (err) {
  log.error('Request failed {Error}', {
    Error: err instanceof Error ? err.message : String(err),
    '@x': err instanceof Error ? err.stack : undefined,
  });
  log.flush(ctx);
  return Response.json({ error: 'Internal error' }, { status: 500 });
}
\`\`\`

## Client Logger (Browser)

Batch logs to reduce requests, use \`sendBeacon\` for reliable delivery on page unload.

\`\`\`typescript
// lib/client-logger.ts
class ClientLogger {
  private buffer: Array<Record<string, unknown>> = [];
  private endpoint: string;
  private apiKey?: string;

  constructor(opts: { endpoint: string; apiKey?: string }) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    if (typeof window !== 'undefined') {
      setInterval(() => this.flush(), 5000); // Auto-flush every 5s
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush(true);
      });
    }
  }

  private log(level: string, template: string, props?: Record<string, unknown>) {
    this.buffer.push({
      '@t': new Date().toISOString(),
      '@l': level,
      '@mt': template,
      ...props,
    });
    if (this.buffer.length >= 10) this.flush(); // Flush at 10 events
  }

  verbose(t: string, p?: Record<string, unknown>) { this.log('Verbose', t, p); }
  debug(t: string, p?: Record<string, unknown>) { this.log('Debug', t, p); }
  info(t: string, p?: Record<string, unknown>) { this.log('Information', t, p); }
  warn(t: string, p?: Record<string, unknown>) { this.log('Warning', t, p); }
  error(t: string, p?: Record<string, unknown>) { this.log('Error', t, p); }
  fatal(t: string, p?: Record<string, unknown>) { this.log('Fatal', t, p); }

  flush(useBeacon = false) {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    const body = events.map(e => JSON.stringify(e)).join('\\n');

    if (useBeacon && navigator.sendBeacon) {
      // sendBeacon for page unload - doesn't support custom headers
      const url = this.apiKey
        ? \`\${this.endpoint}?apiKey=\${encodeURIComponent(this.apiKey)}\`
        : this.endpoint;
      navigator.sendBeacon(url, new Blob([body], { type: 'application/vnd.serilog.clef' }));
    } else {
      const headers: Record<string, string> = { 'Content-Type': 'application/vnd.serilog.clef' };
      if (this.apiKey) headers['X-Seq-ApiKey'] = this.apiKey;
      fetch(this.endpoint, { method: 'POST', headers, body, keepalive: true })
        .catch(err => console.error('Log flush failed:', err));
    }
  }
}

// Singleton - configure once, import anywhere
export const logger = new ClientLogger({
  endpoint: 'https://logs.example.com/ingest/clef',
  apiKey: 'your-client-api-key', // Use dedicated client key (write-only, rotatable)
});
\`\`\`

### Client Usage

\`\`\`typescript
import { logger } from '@/lib/client-logger';

// Log user actions
logger.info('Button clicked {ButtonId}', { ButtonId: 'checkout' });

// Log errors with stack traces
try {
  await submitOrder();
} catch (err) {
  logger.error('Order failed {Error}', {
    Error: err instanceof Error ? err.message : String(err),
    '@x': err instanceof Error ? err.stack : undefined,
  });
}
\`\`\`

## Key Patterns

1. **Message templates**: Use \`{Placeholders}\` not string interpolation - enables grouping by template
2. **waitUntil (server)**: Ensures logs send after response, non-blocking
3. **sendBeacon (client)**: Reliable delivery during page unload
4. **Batch client logs**: Reduces network overhead, flush on threshold or interval
5. **Dedicated client API key**: Visible in browser, but write-only and rotatable
`;


export const OVERVIEW_DOCS = `# Log Cannon (v2, Basin)

Logs are stored in Cloudflare Basin (Iceberg tables in R2) and queried with Basin SQL,
which is Apache DataFusion SQL, not ClickHouse. Ingest is unchanged.

## Access

- **Search:** \`GET /api/v1/logs?source=MyApp&level=Error\` with \`X-Api-Key\` (read scope)
- **SQL:** \`POST /api/v1/query\` with \`{"sql": "SELECT ..."}\` (read scope)
- **MCP:** \`POST /api/mcp\`
- Every read path also answers under \`/v2\` (\`/v2/api/v1/query\`), an alias for callers that moved before cutover
- **Ingest:** \`/ingest/clef\`, \`/api/events/raw\`, \`/ingest/webhook\`, \`/ingest/otlp/*\`, \`/v1/logs\`, \`/v1/traces\`

## Table logs.events

| Column | Type | Notes |
|---|---|---|
| id | string | UUID |
| ts | timestamp | Event time (CLEF @t, OTLP time). Use this for time ranges |
| received_at | timestamp | When the Worker accepted it. Ingest lag is received_at - ts |
| source | string | Key name, or OTLP service.name / webhook preset override |
| key_id | string | The API key that sent it |
| format | string | clef, otlp, webhook, api, supabase |
| kind | string | log or span |
| level | string | Verbose, Debug, Information, Warning, Error, Fatal |
| message | string | Rendered message |
| message_template | string | Template with {Placeholders} |
| event_type | string | Template hash (CLEF @i wins) |
| exception | string | Exception / stack trace |
| trace_id, span_id, parent_span_id | string | Tracing ids (hex) |
| duration_ms | double | Span duration |
| properties | json (text) | Structured properties |

## Supabase platform logs (format = 'supabase')

Pulled from the Supabase Management API once a minute, one source per project
(\`<name>-supabase\`). \`id\` is the Supabase row id, \`key_id\` is \`supabase-pull\`, and
\`message\` is the Supabase event_message. Properties: \`Source\` (same as the column),
\`LogTable\` (postgres_logs, auth_logs, function_logs, function_edge_logs), \`ProjectRef\`,
\`sb_id\`, and every log attribute flattened to \`sb_<path>\` (request.path → \`sb_request_path\`).
function_edge_logs rows keep method, path, URL, status, function and execution ids,
timing and user agent (\`sb_request_method\`, \`sb_request_pathname\`, \`sb_response_status_code\`,
\`sb_function_id\`, \`sb_execution_id\`, \`sb_execution_time_ms\`); Cloudflare request context,
most headers and connecting IPs are dropped so the row stays under the 2000-byte limit.
Delivery is at-least-once: count(DISTINCT id) when an exact count matters. The puller's
own per-run summary is source \`supabase-pull\` (Error level when a table failed).

## Things that differ from ClickHouse

- **Data is 1-2 minutes behind.** Rows land when the sink rolls (60 s) and commits.
  For "nothing arrived" checks, end the window at now() - INTERVAL '3 minutes'.
- **During a Basin write outage, rows arrive late, not never.** The Worker retries,
  then holds what Basin won't take and replays it oldest first once it recovers. Those
  rows keep their id and received_at, so a "nothing arrived" window can fill in after the
  fact. Delivery is at-least-once: count(DISTINCT id) when an exact count matters.
- **json_get_* fails the whole query if any row's properties is over 2000 bytes.**
  Guard it: \`CASE WHEN octet_length(properties) <= 2000 THEN json_get_str(properties, 'k') END\`.
  For big rows, \`(regexp_match(properties, '"k":"([^"]*)"'))[1]\` reads a top-level string.
  The search API and MCP search_logs apply both for you.
- **Results are capped at 10,000 rows.** Page by time window for more.
- **Read-only.** No INSERT, ALTER or DELETE.

## Dialect

| ClickHouse | Basin SQL |
|---|---|
| countIf(x) | count(*) FILTER (WHERE x) |
| uniqExact(x) | count(DISTINCT x) |
| toStartOfMinute(ts) | date_trunc('minute', ts) |
| JSONExtractString(properties, 'k') | json_get_str(properties, 'k') (guarded, above) |
| JSONExtractFloat(properties, 'k') | json_get_float(properties, 'k') |
| now() - INTERVAL 1 HOUR | now() - INTERVAL '1 hour' |
| formatDateTime(ts, ...) | to_char(ts, '%Y-%m-%d %H:%M:%S') |
| any(x) | min(x) |
| message ILIKE '%x%' | message ILIKE '%x%' (same) |

## Examples

\`\`\`sql
-- errors per hour for one source, last day
SELECT date_trunc('hour', ts) AS hour, count(*) AS errors
FROM logs.events
WHERE source = 'MyApp' AND level IN ('Error', 'Fatal') AND ts > now() - INTERVAL '1 day'
GROUP BY 1 ORDER BY 1

-- slowest spans of a trace
SELECT message, duration_ms FROM logs.events
WHERE kind = 'span' AND trace_id = '0af7651916cd43dd8448eb211c80319c'
ORDER BY duration_ms DESC LIMIT 20

-- a property, safely
SELECT CASE WHEN octet_length(properties) <= 2000 THEN json_get_str(properties, 'RequestPath') END AS path,
       count(*) AS n
FROM logs.events WHERE source = 'MyApp' AND ts > now() - INTERVAL '1 hour'
GROUP BY 1 ORDER BY n DESC LIMIT 20
\`\`\`

## Alerts

Alerts run on Basin from a once-a-minute cron. An alert is a SELECT that returns one row of numbers, plus a condition over that row's columns (\`cnt > 50\`, \`errors >= 10 && total > 100\`; \`&&\` binds before \`||\`, no parentheses). \`now()\` in an alert query is the evaluation time minus about 3 minutes, so a "last 5 minutes" window never ends in data Basin hasn't received yet. Test a query with \`POST /api/v1/alerts/:id/test\` before saving it. See the api section.
`;

export const API_DOCS = `# Log Cannon API (v2, Basin)

Base: \`https://logs.redleg.dev\` (\`https://logs.redleg.dev/v2\` is an alias). Auth: \`X-Api-Key: <key>\` or \`Authorization: Bearer <key>\`.
Scopes: ingest < read < write < admin. Reads need \`read\`.

## GET /api/v1/logs

Structured search, newest first.

| Param | Notes |
|---|---|
| source, level | Exact match |
| search | Substring of message (literal, case-sensitive) |
| trace_id | Exact match |
| hours | Look-back window, default 24, max 720 |
| limit | Default 100, max 1000 |
| prop.<key>=<value> | Property filter. Dot paths for nesting. Prefix the value with >, >=, <, <=, != for comparisons |

Response: \`{"data": [{id, ts, timestamp, level, message, message_template, source, exception?, trace_id?, ..., properties}], "meta": {count, limit, bytes_scanned}}\`

\`timestamp\` repeats \`ts\` for v1 callers; use \`ts\`. The \`/v2\` alias leaves it out.

Property filters on rows whose properties exceed 2000 bytes match top-level keys only.

## POST /api/v1/query

Body \`{"sql": "SELECT ..."}\`. SELECT or WITH only. A query with no LIMIT gets LIMIT 10000.

Response: \`{"data": [...], "meta": {rows, elapsed_ms, bytes_scanned}}\`

## Alerts

Same shapes as v1. GET needs \`read\`; POST, PATCH and DELETE need \`write\`.

- \`GET /api/v1/alerts\` → \`{"data": [{id, name, description, query, condition, interval_seconds, cooldown_seconds, recipients, destination_ids, subject, enabled, last_triggered_at, last_run_at, last_status, last_value, last_error}]}\`. \`last_status\` is ok, triggered, cooldown or error.
- \`POST /api/v1/alerts\` with \`{name, query, condition, subject, destination_ids or recipients, description?, interval_seconds? (>= 30, default 60), cooldown_seconds? (default 300), enabled?, id?}\` → 201 \`{success, id}\`.
- \`PATCH /api/v1/alerts\` with \`{id, ...fields}\` changes only the named fields. \`DELETE /api/v1/alerts\` with \`{id}\`.
- \`POST /api/v1/alerts/:id/test\` with \`{query?, condition?}\` (defaults to the stored alert's) runs the query exactly as the evaluator would, with now() pinned to evaluation time minus the lag, and returns \`{"data": rows, "meta": {evaluated_as_of, condition, would_fire, condition_error?}}\`. Add \`"deliver": true\` (write scope, stored alert only) to also send the first row to the alert's destinations, whether or not it would fire, with "[Test] " on the email subject; \`meta.delivery\` is \`{delivered, attempts: [{target, ok, error?}]}\`. A test delivery never starts the cooldown.
- \`/api/v1/alert-destinations\`: GET, POST \`{name, type: email|webhook, config: {email} | {url, method?, headers?, timeout_seconds?}}\`, PATCH \`{id, ...}\`, DELETE \`{id}\`.

Alert queries are Basin SQL. The query runs every interval (evaluated at most once a minute) and the condition is checked against its first row. A missing column, a non-number, or no rows is an evaluation error, which never fires the alert and is reported on source log-cannon-alerts.

## Errors

\`{"error": "<code>", "message": "...", "hints"?: [...]}\`

| Status | error | When |
|---|---|---|
| 400 | validation_error / query_error | Missing SQL, not a SELECT, or Basin rejected it. hints lists ClickHouse spellings found in the query |
| 401 | unauthorized | Missing key |
| 403 | forbidden | Invalid/disabled key, or missing scope |
| 502 | upstream_error | Basin SQL failed |
| 504 | query_timeout | Over 30 s |

DELETE /api/v1/logs is not available: Basin is read-only. Retention is per key.
`;
