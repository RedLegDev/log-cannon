import { getEndpoints, queryClickHouse } from '@/lib/clickhouse';

const STATIC_DOCS = `# Log Cannon

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

List and retrieve dashboards via \`GET /api/v1/dashboards\` (all) or \`GET /api/v1/dashboards/{name}\` (single). Requires API key.
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
    return new Response(`# Log Cannon \n\nError generating documentation: ${errorMessage}\n\nPlease ensure ClickHouse is running and accessible.`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}
