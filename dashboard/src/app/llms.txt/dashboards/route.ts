const DASHBOARD_DOCS = `# Log Cannon - Dashboard & Widget Reference

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

export async function GET() {
  return new Response(DASHBOARD_DOCS, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
