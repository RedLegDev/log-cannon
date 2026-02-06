const API_DOCS = `# Log Cannon - API v1

REST API for programmatic access. Authenticate with an API key.

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
  "recipients": ["ops@example.com"],
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
- **recipients**: Array of email addresses (required, at least one)
- **subject**: Email subject line (required)

**Condition Syntax:** \`>\`, \`<\`, \`>=\`, \`<=\`, \`==\`, \`!=\`, \`&&\` (AND), \`||\` (OR). Variables are column names from your query.

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

export async function GET() {
  return new Response(API_DOCS, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
