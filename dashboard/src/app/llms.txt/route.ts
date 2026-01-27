import { getDashboards, getEndpoints, queryClickHouse } from '@/lib/clickhouse';

const STATIC_DOCS = `# Log Cannon - Dashboard Builder

This document describes how to create dashboards for Log Cannon, a log ingestion and visualization system built on ClickHouse.

## Dashboard Schema

A dashboard has a name, description, and config object:

\`\`\`json
{
  "name": "my-dashboard",
  "description": "What this dashboard shows",
  "config": {
    "layout": "auto",
    "widgets": [...]
  }
}
\`\`\`

- **name**: URL-safe identifier (used in URLs like /dashboards/my-dashboard)
- **description**: Human-readable description
- **config.layout**: "auto" (responsive grid) or "grid" (manually positioned)
- **config.widgets**: Array of widget configurations

## Widget Structure

Each widget requires:

\`\`\`json
{
  "id": "unique-widget-id",
  "type": "stat",
  "title": "Display Title",
  "dataSource": { ... },
  "visualization": { ... }
}
\`\`\`

- **id**: Unique identifier within the dashboard
- **type**: One of "stat", "line_chart", "bar_chart", "table"
- **title**: Display title shown above the widget
- **dataSource**: Where to get data (required)
- **visualization**: How to render it (optional, type-specific defaults apply)

## Data Source Options

### Option 1: Reference an existing endpoint

\`\`\`json
{
  "type": "endpoint",
  "endpointName": "my-endpoint",
  "params": { "source": "MyApp" },
  "refreshInterval": 30
}
\`\`\`

### Option 2: Inline SQL query

\`\`\`json
{
  "type": "inline",
  "sql": "SELECT count() as value FROM logs.events WHERE timestamp > now() - INTERVAL 1 HOUR",
  "refreshInterval": 60
}
\`\`\`

- **refreshInterval**: Optional, seconds between auto-refresh (omit for no auto-refresh)
- Inline SQL must be SELECT statements only (security restriction)

## Widget Types

### stat - Single Metric Display

Shows a single number prominently. Best for KPIs and counts.

\`\`\`json
{
  "id": "error-count",
  "type": "stat",
  "title": "Errors (24h)",
  "dataSource": {
    "type": "inline",
    "sql": "SELECT count() as value FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR"
  },
  "visualization": {
    "valueField": "value",
    "format": "number"
  }
}
\`\`\`

Visualization options:
- **valueField**: Which result field to display (default: "value")
- **format**: "number" (with commas), "percent" (adds %), "duration" (formats as time)

### line_chart - Time Series

Shows values over time. Best for trends and patterns.

\`\`\`json
{
  "id": "errors-over-time",
  "type": "line_chart",
  "title": "Errors Over Time",
  "dataSource": {
    "type": "inline",
    "sql": "SELECT toStartOfMinute(timestamp) as time, count() as errors FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 1 HOUR GROUP BY time ORDER BY time"
  },
  "visualization": {
    "xField": "time",
    "yField": "errors"
  }
}
\`\`\`

Visualization options:
- **xField**: Field for X axis (typically time)
- **yField**: Field(s) for Y axis - string or array of strings for multiple lines
- **colors**: Optional array of colors for lines

### bar_chart - Categorical Comparison

Shows values across categories. Best for comparisons.

\`\`\`json
{
  "id": "errors-by-source",
  "type": "bar_chart",
  "title": "Errors by Service",
  "dataSource": {
    "type": "inline",
    "sql": "SELECT source, count() as errors FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR GROUP BY source ORDER BY errors DESC LIMIT 10"
  },
  "visualization": {
    "xField": "source",
    "yField": "errors"
  }
}
\`\`\`

Visualization options:
- **xField**: Field for categories (X axis)
- **yField**: Field for values (Y axis)
- **colors**: Optional array of colors for bars

### table - Tabular Data

Shows data in rows and columns. Best for detailed views.

\`\`\`json
{
  "id": "recent-errors",
  "type": "table",
  "title": "Recent Errors",
  "dataSource": {
    "type": "inline",
    "sql": "SELECT formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S') as time, source, message FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 1 HOUR ORDER BY timestamp DESC LIMIT 20"
  },
  "visualization": {
    "columns": ["time", "source", "message"],
    "sortBy": "time"
  }
}
\`\`\`

Visualization options:
- **columns**: Which fields to display (in order)
- **sortBy**: Default sort field

## Data Model

### Events Table (logs.events)

| Column           | Type              | Description                                    |
|------------------|-------------------|------------------------------------------------|
| id               | UUID              | Unique event identifier                        |
| timestamp        | DateTime64(3)     | When the event occurred                        |
| level            | String            | Log level (Information, Warning, Error, Debug) |
| message_template | String            | Template with placeholders                     |
| message          | String            | Rendered message                               |
| exception        | String            | Exception details if any                       |
| event_type       | String            | Event classification                           |
| source           | String            | Application/service name                       |
| properties       | String            | JSON object with structured data               |

### Querying Properties

The properties column contains a JSON string with structured data. Use ClickHouse JSON functions:

\`\`\`sql
-- Extract string value
JSONExtractString(properties, 'key')

-- Extract numeric value
JSONExtractFloat(properties, 'key')

-- Nested extraction
JSONExtractString(properties, 'outer', 'inner')

-- Check if property exists
JSONHas(properties, 'key')
\`\`\`

### Common Query Patterns

\`\`\`sql
-- Filter by source
WHERE source = 'MyApp'

-- Filter by level
WHERE level = 'Error'

-- Time ranges
WHERE timestamp > now() - INTERVAL 24 HOUR
WHERE timestamp > now() - INTERVAL 1 HOUR
WHERE timestamp > today()

-- Search messages
WHERE message LIKE '%timeout%'
WHERE message ILIKE '%error%'  -- case insensitive

-- Group by time buckets
GROUP BY toStartOfMinute(timestamp)
GROUP BY toStartOfHour(timestamp)
GROUP BY toStartOfDay(timestamp)

-- Filter by property value
WHERE JSONExtractString(properties, 'Environment') = 'Production'
WHERE JSONExtractFloat(properties, 'Duration') > 1000
\`\`\`

### Time Formatting

Use formatDateTime for display:
\`\`\`sql
formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S') as formatted_time
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

function formatDashboards(dashboards: { name: string; description: string; config: string; enabled: number }[]): string {
  const enabledDashboards = dashboards.filter(d => d.enabled);

  if (enabledDashboards.length === 0) {
    return 'No dashboards configured yet. See the examples above to create your first dashboard.';
  }

  return enabledDashboards.map(d => {
    let configPretty: string;
    try {
      const parsed = JSON.parse(d.config);
      configPretty = JSON.stringify(parsed, null, 2);
    } catch {
      configPretty = d.config;
    }

    return `### ${d.name}
${d.description || 'No description'}

\`\`\`json
${configPretty}
\`\`\`
`;
  }).join('\n');
}

export async function GET() {
  try {
    // Fetch dynamic data
    const [sources, levels, propertyKeys, endpoints, dashboards] = await Promise.all([
      getActiveSources(),
      getActiveLevels(),
      discoverPropertyKeys(),
      getEndpoints(),
      getDashboards()
    ]);

    // Build dynamic sections
    const dynamicDocs = `
## Available Data (Live)

This section shows what data is currently available in your Log Cannon instance.

### Active Sources
Applications currently sending logs:
${sources.length > 0 ? sources.map(s => `- ${s}`).join('\n') : '- No sources found in the last 24 hours'}

### Log Levels in Use
${levels.length > 0 ? levels.map(l => `- ${l}`).join('\n') : '- No logs found in the last 24 hours'}

### Discovered Property Keys
Common properties found in recent logs (last hour):
${propertyKeys.length > 0
  ? propertyKeys.map(p => `- **${p.key}**: e.g. "${p.sampleValue}"`).join('\n')
  : '- No properties discovered (logs may not have structured properties)'}

## Existing Endpoints

These are reusable SQL queries you can reference in widgets by name:

${formatEndpoints(endpoints)}

## Example Dashboards

These are dashboards currently configured in the system:

${formatDashboards(dashboards)}

## Tips for Creating Dashboards

1. **Start simple**: Begin with a few stat widgets showing key metrics
2. **Use existing endpoints**: Reference endpoints when possible for consistency
3. **Add time context**: Include time-based charts to show trends
4. **Group related widgets**: Use descriptive titles and logical ordering
5. **Set refresh intervals**: For real-time monitoring, use 30-60 second refresh
6. **Test queries first**: Run SQL in ClickHouse or use the Endpoints page to validate queries

## Complete Dashboard Example

Here's a comprehensive example combining multiple widget types:

\`\`\`json
{
  "name": "service-overview",
  "description": "Overview metrics for a specific service",
  "config": {
    "layout": "auto",
    "widgets": [
      {
        "id": "total-events",
        "type": "stat",
        "title": "Total Events (24h)",
        "dataSource": {
          "type": "inline",
          "sql": "SELECT count() as value FROM logs.events WHERE timestamp > now() - INTERVAL 24 HOUR",
          "refreshInterval": 60
        },
        "visualization": { "valueField": "value", "format": "number" }
      },
      {
        "id": "error-count",
        "type": "stat",
        "title": "Errors (24h)",
        "dataSource": {
          "type": "inline",
          "sql": "SELECT count() as value FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR",
          "refreshInterval": 60
        },
        "visualization": { "valueField": "value", "format": "number" }
      },
      {
        "id": "events-over-time",
        "type": "line_chart",
        "title": "Events Over Time",
        "dataSource": {
          "type": "inline",
          "sql": "SELECT toStartOfMinute(timestamp) as time, count() as events FROM logs.events WHERE timestamp > now() - INTERVAL 1 HOUR GROUP BY time ORDER BY time",
          "refreshInterval": 30
        },
        "visualization": { "xField": "time", "yField": "events" }
      },
      {
        "id": "by-level",
        "type": "bar_chart",
        "title": "Events by Level",
        "dataSource": {
          "type": "inline",
          "sql": "SELECT level, count() as count FROM logs.events WHERE timestamp > now() - INTERVAL 24 HOUR GROUP BY level ORDER BY count DESC",
          "refreshInterval": 60
        },
        "visualization": { "xField": "level", "yField": "count" }
      },
      {
        "id": "recent-errors",
        "type": "table",
        "title": "Recent Errors",
        "dataSource": {
          "type": "inline",
          "sql": "SELECT formatDateTime(timestamp, '%H:%i:%S') as time, source, substring(message, 1, 100) as message FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 1 HOUR ORDER BY timestamp DESC LIMIT 10",
          "refreshInterval": 30
        },
        "visualization": { "columns": ["time", "source", "message"] }
      }
    ]
  }
}
\`\`\`
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
