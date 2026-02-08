import { getEndpoints, queryClickHouse } from '@/lib/clickhouse';

const STATIC_DOCS = `# Log Cannon - Dashboard Builder

> Sub-pages: /llms.txt/api (REST API reference), /llms.txt/logger (logger integration)

Log Cannon is a log ingestion and visualization system built on ClickHouse.

## API Access

All programmatic access uses \`/api/v1/\` endpoints with an API key.

Quick reference (see /llms.txt/api for full details):
- **Query logs:** \`GET /api/v1/logs?source=MyApp&level=Error\` with \`X-Api-Key\` header
- **Run SQL:** \`POST /api/v1/query\` with \`{"sql": "SELECT ..."}\` body and \`X-Api-Key\` header
- **Dashboards:** \`GET/POST /api/v1/dashboards\`
- **Endpoints:** \`GET/POST /api/v1/endpoints\`
- **Ingest logs:** \`POST /ingest/clef\` with \`X-Seq-ApiKey\` header (see /llms.txt/logger)

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

## Data Model (logs.events)

| Column | Type | Description |
|---|---|---|
| id | UUID | Unique event identifier |
| timestamp | DateTime64(3) | When the event occurred |
| level | String | Information, Warning, Error, Debug |
| message_template | String | Template with placeholders |
| message | String | Rendered message |
| exception | String | Exception details |
| event_type | String | Event classification |
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
  // Sample recent events and extract property keys
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


export async function GET() {
  try {
    // Fetch dynamic data
    const [sources, levels, propertyKeys, endpoints] = await Promise.all([
      getActiveSources(),
      getActiveLevels(),
      discoverPropertyKeys(),
      getEndpoints()
    ]);

    // Build dynamic sections
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

${formatDashboards(dashboards)}
`;

    const fullDocument = STATIC_DOCS + dynamicDocs;

    return new Response(fullDocument, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(`# Log Cannon - Dashboard Builder\n\nError generating documentation: ${errorMessage}\n\nPlease ensure ClickHouse is running and accessible.`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}
