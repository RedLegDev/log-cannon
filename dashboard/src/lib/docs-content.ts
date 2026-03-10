import { getEndpoints, queryClickHouse } from './clickhouse';

// ── Static docs ────────────────────────────────────────────

export const API_DOCS = `# Log Cannon - API v1

REST API for programmatic access. Authenticate with an API key.

All endpoints are under \`/api/v1/\`.

## Authentication

Include your API key in requests:

\`\`\`bash
# Header method (preferred)
curl -H "X-Api-Key: your-key-here" https://your-instance/api/v1/logs

# Bearer token method
curl -H "Authorization: Bearer your-key-here" https://your-instance/api/v1/logs
\`\`\`

## Scopes

API keys have permission scopes:
- **ingest**: Write logs only (default for existing keys)
- **read**: Query logs, view dashboards/endpoints/queries
- **write**: Everything in read + create/update/delete resources
- **admin**: Everything in write + manage API keys

## Endpoints

### Logs

\`\`\`bash
# Search logs
GET /api/v1/logs?source=MyApp&level=Error&search=timeout&limit=100

# Property filters
GET /api/v1/logs?prop.userId=123&prop.duration=>500
\`\`\`

### Query

\`\`\`bash
# Execute arbitrary SELECT query
POST /api/v1/query
Content-Type: application/json

{"sql": "SELECT source, count() as count FROM logs.events GROUP BY source"}
\`\`\`

### Dashboards

\`\`\`bash
GET /api/v1/dashboards              # List all
GET /api/v1/dashboards/:name        # Get one
POST /api/v1/dashboards             # Create
PATCH /api/v1/dashboards/:name      # Update
DELETE /api/v1/dashboards/:name     # Delete
\`\`\`

### Endpoints (Stored Queries)

\`\`\`bash
GET /api/v1/endpoints               # List all
GET /api/v1/endpoints/:name?param=value  # Execute with params
POST /api/v1/endpoints              # Create
PATCH /api/v1/endpoints/:name       # Update
DELETE /api/v1/endpoints/:name      # Delete
\`\`\`

### Saved Queries

\`\`\`bash
GET /api/v1/saved-queries           # List all
POST /api/v1/saved-queries          # Create
DELETE /api/v1/saved-queries/:id    # Delete
\`\`\`

### Alerts

\`\`\`bash
GET /api/v1/alerts                  # List all alerts
POST /api/v1/alerts                 # Create new alert
PATCH /api/v1/alerts                # Update alert (pass id in body)
DELETE /api/v1/alerts               # Delete alert (pass id in body)
POST /api/v1/alerts/:id/test        # Test alert query
\`\`\`

**Create Alert Request:**
\`\`\`json
{
  "name": "High Error Rate",
  "description": "Triggers when errors exceed threshold",
  "query": "SELECT count(*) as cnt FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 5 MINUTE",
  "condition": "cnt > 50",
  "interval_seconds": 60,
  "cooldown_seconds": 300,
  "destination_ids": ["uuid-of-destination"],
  "subject": "[ALERT] High error rate detected"
}
\`\`\`

**Alert Fields:**
- **name**: Human-readable alert name (required)
- **description**: Optional description
- **query**: SELECT query returning numeric values for condition evaluation (required)
- **condition**: Expression like \`cnt > 50\`, \`errors == 0\`, \`total >= 100 && errors > 5\` (required)
- **interval_seconds**: How often to check (min 30, default 60)
- **cooldown_seconds**: Min time between repeated alerts (default 300)
- **destination_ids**: Array of alert destination UUIDs (preferred — see Alert Destinations below)
- **recipients**: Array of email addresses (legacy, use destination_ids instead)
- **subject**: Email subject line (required)

**Condition Syntax:** \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`, \`&&\` (AND), \`||\` (OR). Variables are column names from your query.

### Alert Destinations

Reusable notification targets (email or webhook) that can be assigned to multiple alerts or triggered manually from the log explorer.

\`\`\`bash
GET /api/v1/alert-destinations              # List all destinations
POST /api/v1/alert-destinations             # Create destination
PATCH /api/v1/alert-destinations            # Update (pass id in body)
DELETE /api/v1/alert-destinations           # Delete (pass id in body)
\`\`\`

**Create Email Destination:**
\`\`\`json
{
  "name": "Ops Team",
  "type": "email",
  "config": { "email": "ops@example.com", "from": "alerts@yourdomain.com" }
}
\`\`\`

**Create Webhook Destination:**
\`\`\`json
{
  "name": "Make Scenario",
  "type": "webhook",
  "config": {
    "url": "https://hook.make.com/abc123",
    "method": "POST",
    "headers": { "X-Custom-Auth": "token123" },
    "timeout_seconds": 10
  }
}
\`\`\`

**Webhook Payload (sent by alerts and manual triggers):**
\`\`\`json
{
  "alert_id": "uuid or 'manual'",
  "alert_name": "High Error Rate",
  "description": "...",
  "query": "SELECT count(*) as cnt FROM logs.events WHERE ...",
  "condition": "cnt > 50",
  "triggered_at": "2026-02-19T12:00:00Z",
  "query_result": { "cnt": 127, "service": "api" }
}
\`\`\`

The \`query\` field contains the full SQL used to evaluate the alert, so consuming applications can re-run it via \`POST /api/v1/query\` to fetch related events.

**Destination Types:**
- **email**: Requires \`config.email\`. Optional \`config.from\` to override sender address.
- **webhook**: Requires \`config.url\`. Optional \`config.method\` (default POST), \`config.headers\` (key-value pairs), \`config.timeout_seconds\` (default 10).

### API Keys (admin scope required)

\`\`\`bash
GET /api/v1/keys                    # List all (keys masked)
POST /api/v1/keys                   # Create (returns key once)
PATCH /api/v1/keys/:id              # Update name/scopes/enabled
DELETE /api/v1/keys/:id             # Revoke
\`\`\`

## Error Responses

\`\`\`json
{
  "error": "error_code",
  "message": "Human-readable description",
  "details": { "fields": { "name": "Required field" } }
}
\`\`\`

Error codes: \`unauthorized\`, \`forbidden\`, \`not_found\`, \`validation_error\`, \`query_error\`, \`query_timeout\`, \`internal_error\`
`;

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

1. **Message templates**: Use \`{Placeholders}\` not string interpolation - enables grouping in dashboards
2. **waitUntil (server)**: Ensures logs send after response, non-blocking
3. **sendBeacon (client)**: Reliable delivery during page unload
4. **Batch client logs**: Reduces network overhead, flush on threshold or interval
5. **Dedicated client API key**: Visible in browser, but write-only and rotatable
`;

export const DASHBOARD_DOCS = `# Log Cannon - Dashboard & Widget Reference

## Dashboard Schema

\`\`\`json
{ "name": "my-dashboard", "description": "What this dashboard shows", "config": { "layout": "auto", "widgets": [...] } }
\`\`\`

- **name**: URL-safe identifier (used in /dashboards/my-dashboard)
- **config.layout**: "auto" (responsive grid) or "grid" (manually positioned)
- **config.widgets**: Array of widget objects

## Widget Structure

\`\`\`json
{ "id": "unique-id", "type": "stat", "title": "Display Title", "dataSource": { ... }, "visualization": { ... } }
\`\`\`

- **type**: One of "stat", "line_chart", "bar_chart", "pie_chart", "doughnut_chart", "scatter_chart", "table"
- **dataSource**: Required. Either an endpoint reference or inline SQL.
- **visualization**: Optional, type-specific defaults apply.

## Data Sources

**Endpoint reference:** \`{ "type": "endpoint", "endpointName": "my-endpoint", "params": { "source": "MyApp" }, "refreshInterval": 30 }\`

**Inline SQL:** \`{ "type": "inline", "sql": "SELECT count() as value FROM logs.events WHERE timestamp > now() - INTERVAL 1 HOUR", "refreshInterval": 60 }\`

refreshInterval is optional (seconds). Inline SQL must be SELECT only.

## Widget Types

### stat

Single metric display. Visualization: **valueField** (default "value"), **format** ("number", "percent", "duration").

\`\`\`json
{
  "id": "error-count", "type": "stat", "title": "Errors (24h)",
  "dataSource": { "type": "inline", "sql": "SELECT count() as value FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR" },
  "visualization": { "valueField": "value", "format": "number" }
}
\`\`\`

### line_chart

Time series. Visualization: **xField**, **yField** (string or array for multi-series), **colors** (optional array).

For multi-series, use an array for yField (e.g. \`["errors", "warnings"]\`) with \`countIf()\` in your query.

\`\`\`json
{
  "id": "errors-over-time", "type": "line_chart", "title": "Errors Over Time",
  "dataSource": { "type": "inline", "sql": "SELECT toStartOfMinute(timestamp) as time, count() as errors FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 1 HOUR GROUP BY time ORDER BY time" },
  "visualization": { "xField": "time", "yField": "errors" }
}
\`\`\`

### bar_chart

Categorical comparison. Visualization: **xField**, **yField**, **colors** (optional).

\`\`\`json
{
  "id": "errors-by-source", "type": "bar_chart", "title": "Errors by Service",
  "dataSource": { "type": "inline", "sql": "SELECT source, count() as errors FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR GROUP BY source ORDER BY errors DESC LIMIT 10" },
  "visualization": { "xField": "source", "yField": "errors" }
}
\`\`\`

### pie_chart / doughnut_chart

Proportional slices (doughnut_chart is identical but with a hollow center). Visualization: **xField** (labels), **yField** (values, single field), **colors** (optional). Limit to 8 slices.

\`\`\`json
{
  "id": "errors-by-source", "type": "pie_chart", "title": "Errors by Source",
  "dataSource": { "type": "inline", "sql": "SELECT source as name, count() as count FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR GROUP BY source ORDER BY count DESC LIMIT 8" },
  "visualization": { "xField": "name", "yField": "count" }
}
\`\`\`

### scatter_chart

Two numeric variables. Visualization: **xField**, **yField** (both numeric, single field), **colors** (optional). Use LIMIT 500-1000.

\`\`\`json
{
  "id": "response-time-vs-size", "type": "scatter_chart", "title": "Response Time vs Payload Size",
  "dataSource": { "type": "inline", "sql": "SELECT JSONExtractFloat(properties, 'PayloadSize') as size, JSONExtractFloat(properties, 'ResponseTime') as time FROM logs.events WHERE timestamp > now() - INTERVAL 1 HOUR AND JSONHas(properties, 'PayloadSize') LIMIT 500" },
  "visualization": { "xField": "size", "yField": "time" }
}
\`\`\`

### table

Tabular data. Visualization: **columns** (array of field names), **sortBy** (default sort field).

\`\`\`json
{
  "id": "recent-errors", "type": "table", "title": "Recent Errors",
  "dataSource": { "type": "inline", "sql": "SELECT formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S') as time, source, message FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 1 HOUR ORDER BY timestamp DESC LIMIT 20" },
  "visualization": { "columns": ["time", "source", "message"], "sortBy": "time" }
}
\`\`\`

## Managing Dashboards

List and retrieve existing dashboards via \`GET /api/v1/dashboards\` (all) or \`GET /api/v1/dashboards/{name}\` (single).
Create or update via \`POST /api/v1/dashboards\` or \`PATCH /api/v1/dashboards/{name}\`. Requires API key.
`;

// ── Dynamic docs (overview) ────────────────────────────────

const STATIC_OVERVIEW = `# Log Cannon

> Sub-pages:
 - /llms.txt/api (REST API reference)
 - /llms.txt/dashboards (dashboard & widget schema)
 - /llms.txt/logger (logger integration)

Log Cannon is a log ingestion and visualization system built on ClickHouse.

## API Access

All programmatic access uses \`/api/v1/\` endpoints with an API key.

Quick reference (see /llms.txt/api for full details):
- **Query logs:** \`GET /api/v1/logs?source=MyApp&level=Error\` with \`X-Api-Key\` header
- **Run SQL:** \`POST /api/v1/query\` with \`{"sql": "SELECT ..."}\` body and \`X-Api-Key\` header
- **Dashboards:** \`GET/POST /api/v1/dashboards\`
- **Endpoints:** \`GET/POST /api/v1/endpoints\`
- **Ingest logs (CLEF):** \`POST /ingest/clef\` with \`X-Api-Key\` or \`X-Seq-ApiKey\` header (see /llms.txt/logger)
- **Ingest logs (Webhook):** \`POST /ingest/webhook?preset=cloudflare\` — ndjson, gzip supported
- **Ingest logs (OTLP):** \`POST /ingest/otlp/logs\` and \`POST /ingest/otlp/traces\` — OpenTelemetry protocol (also available at \`/v1/logs\` and \`/v1/traces\`)
- **Alert Destinations:** \`GET/POST/PATCH/DELETE /api/v1/alert-destinations\` — reusable notification targets (email + webhook)

## Dashboards

Dashboard and widget schema, types, data sources, and examples are at /llms.txt/dashboards.
Manage existing dashboards via \`GET/POST/PATCH/DELETE /api/v1/dashboards\` (requires API key).

## Data Model (logs.events)

| Column | Type | Description |
|---|---|---|
| id | UUID | Unique event identifier |
| timestamp | DateTime64(3) | When the event occurred |
| level | String | Information, Warning, Error, Debug |
| message_template | String | Template with placeholders |
| message | String | Rendered message |
| exception | String | Exception details |
| event_type | String | MurmurHash3 hash of message_template (e.g. 0x5432a8ff). Auto-computed at ingest; client-provided @i takes precedence |
| source | String | Application/service name |
| properties | String | JSON object with structured data |

### Querying Properties

\`\`\`sql
JSONExtractString(properties, 'key')         -- string value
JSONExtractFloat(properties, 'key')          -- numeric value
JSONExtractString(properties, 'outer', 'inner') -- nested
JSONHas(properties, 'key')                   -- existence check
\`\`\`

### Common Patterns

\`\`\`sql
WHERE source = 'MyApp'                                    -- filter by source
WHERE level = 'Error'                                     -- filter by level
WHERE timestamp > now() - INTERVAL 24 HOUR                -- time range
WHERE message ILIKE '%error%'                             -- search messages
GROUP BY toStartOfMinute(timestamp)                       -- time buckets (also: toStartOfHour, toStartOfDay)
WHERE JSONExtractString(properties, 'Environment') = 'Production'  -- property filter
formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S') as time   -- time formatting
\`\`\`

`;

async function getActiveSources(): Promise<string[]> {
  const sql = `
    SELECT DISTINCT source
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
    ORDER BY source
  `;
  const results = await queryClickHouse<{ source: string }>(sql);
  return results.map(r => r.source);
}

async function getActiveLevels(): Promise<string[]> {
  const sql = `
    SELECT DISTINCT level
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 24 HOUR
    ORDER BY level
  `;
  const results = await queryClickHouse<{ level: string }>(sql);
  return results.map(r => r.level);
}

async function discoverPropertyKeys(): Promise<{ key: string; sampleValue: string }[]> {
  const sql = `
    SELECT properties
    FROM logs.events
    WHERE timestamp > now() - INTERVAL 1 HOUR
      AND properties != ''
      AND properties != '{}'
    LIMIT 100
  `;

  const results = await queryClickHouse<{ properties: string }>(sql);
  const keyMap = new Map<string, string>();

  for (const row of results) {
    try {
      const props = JSON.parse(row.properties);
      for (const [key, value] of Object.entries(props)) {
        if (!keyMap.has(key) && value !== null && value !== undefined) {
          const sampleValue = typeof value === 'object'
            ? '(object)'
            : String(value).slice(0, 50);
          keyMap.set(key, sampleValue);
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return Array.from(keyMap.entries())
    .map(([key, sampleValue]) => ({ key, sampleValue }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function formatEndpoints(endpoints: { name: string; description: string; sql_query: string; enabled: number }[]): string {
  const enabledEndpoints = endpoints.filter(e => e.enabled);

  if (enabledEndpoints.length === 0) {
    return 'No endpoints configured yet.';
  }

  return enabledEndpoints.map(e => `### ${e.name}
${e.description || 'No description'}

\`\`\`sql
${e.sql_query}
\`\`\`

To use in a widget:
\`\`\`json
{ "type": "endpoint", "endpointName": "${e.name}" }
\`\`\`
`).join('\n');
}

export async function getOverviewDocs(): Promise<string> {
  const [sources, levels, propertyKeys, endpoints] = await Promise.all([
    getActiveSources(),
    getActiveLevels(),
    discoverPropertyKeys(),
    getEndpoints()
  ]);

  const dynamicDocs = `
## Live Data

### Active Sources
${sources.length > 0 ? sources.map(s => `- ${s}`).join('\n') : '- None in last 24 hours'}

### Log Levels
${levels.length > 0 ? levels.map(l => `- ${l}`).join('\n') : '- None in last 24 hours'}

### Property Keys (last hour)
${propertyKeys.length > 0
  ? propertyKeys.map(p => `- **${p.key}**: e.g. "${p.sampleValue}"`).join('\n')
  : '- No properties discovered'}

## Existing Endpoints

Reusable SQL queries you can reference in widgets by name:

${formatEndpoints(endpoints)}

## Existing Dashboards

List and retrieve dashboards via \`GET /api/v1/dashboards\` (all) or \`GET /api/v1/dashboards/{name}\` (single). Requires API key.
`;

  return STATIC_OVERVIEW + dynamicDocs;
}
