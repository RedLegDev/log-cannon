# Log Cannon API v1 Design

## Overview

A REST API for programmatic access to Log Cannon resources (dashboards, endpoints, saved queries, logs). Designed for LLM consumption via Claude skills, but works with any HTTP client.

## Authentication & Permissions

### Header Format

```
X-Api-Key: your-key-here
```

Or:

```
Authorization: Bearer your-key-here
```

### Scopes

| Scope | Allows |
|-------|--------|
| `ingest` | Write logs only (existing behavior, default for existing keys) |
| `read` | Query logs, view dashboards/endpoints/queries |
| `write` | Everything in `read` + create/update/delete resources |
| `admin` | Everything in `write` + manage API keys |

### Schema Change

Add `scopes` column to `logs.api_keys`:

```sql
ALTER TABLE logs.api_keys ADD COLUMN scopes String DEFAULT 'ingest';
```

### Error Responses

```json
{ "error": "unauthorized", "message": "Missing or invalid API key" }
{ "error": "forbidden", "message": "Key lacks required scope: write" }
```

---

## API Endpoints

Base path: `/api/v1/`

### Logs & Queries

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/logs` | read | Search logs with filters |
| `GET` | `/logs/stats` | read | Aggregated stats (counts by level, source) |
| `POST` | `/query` | read | Execute arbitrary SELECT query |

### Dashboards

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/dashboards` | read | List all dashboards |
| `GET` | `/dashboards/:name` | read | Get dashboard by name |
| `POST` | `/dashboards` | write | Create dashboard |
| `PATCH` | `/dashboards/:name` | write | Update dashboard |
| `DELETE` | `/dashboards/:name` | write | Delete dashboard |

### Endpoints (Stored Queries)

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/endpoints` | read | List all endpoints |
| `GET` | `/endpoints/:name` | read | Execute endpoint with params |
| `POST` | `/endpoints` | write | Create endpoint |
| `PATCH` | `/endpoints/:name` | write | Update endpoint |
| `DELETE` | `/endpoints/:name` | write | Delete endpoint |

### Saved Queries

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/saved-queries` | read | List saved queries |
| `POST` | `/saved-queries` | write | Create saved query |
| `DELETE` | `/saved-queries/:id` | write | Delete saved query |

### API Keys

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/keys` | admin | List keys (names/scopes, not secrets) |
| `POST` | `/keys` | admin | Create new key (returns secret once) |
| `PATCH` | `/keys/:id` | admin | Update name/scopes/enabled |
| `DELETE` | `/keys/:id` | admin | Revoke key |

---

## Request/Response Formats

### GET /api/v1/logs

Query parameters:

| Param | Description |
|-------|-------------|
| `source` | Filter by source (exact match) |
| `level` | Filter by levels (comma-separated: `Error,Warning`) |
| `search` | Full-text search in message |
| `from` | Start time (ISO8601, default: 5 minutes ago) |
| `to` | End time (ISO8601, default: now) |
| `limit` | Max results (default 100, max 1000) |
| `offset` | Pagination offset |
| `prop.<key>` | Property filter (e.g., `prop.userId=123`) |
| `prop.<key>` | With operator (e.g., `prop.duration=>500`) |

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "timestamp": "2024-01-01T12:00:00.000Z",
      "level": "Error",
      "message": "Connection timeout after 30s",
      "source": "my-app",
      "properties": { "userId": 123, "duration": 30000 }
    }
  ],
  "meta": { "total": 1542, "limit": 100, "offset": 0 }
}
```

### POST /api/v1/query

Request:

```json
{
  "sql": "SELECT source, count() as count FROM logs.events GROUP BY source ORDER BY count DESC LIMIT 10"
}
```

Response:

```json
{
  "data": [
    { "source": "api-gateway", "count": 50000 },
    { "source": "worker", "count": 12000 }
  ],
  "meta": { "rows": 2, "elapsed_ms": 45 }
}
```

Constraints:
- Only `SELECT` statements allowed
- Query timeout: 30 seconds
- Max rows returned: 10,000

---

## Resource Schemas

### Dashboard

```json
{
  "id": "uuid",
  "name": "api-health",
  "description": "API health metrics and error rates",
  "config": {
    "layout": "grid",
    "columns": 4,
    "widgets": [
      {
        "id": "w1",
        "type": "stat",
        "title": "Requests (24h)",
        "position": { "x": 0, "y": 0, "w": 1, "h": 1 },
        "dataSource": { "type": "endpoint", "name": "request-count-24h" }
      },
      {
        "id": "w2",
        "type": "line_chart",
        "title": "Error Rate",
        "position": { "x": 1, "y": 0, "w": 2, "h": 2 },
        "dataSource": {
          "type": "inline",
          "sql": "SELECT toStartOfHour(timestamp) as time, countIf(level='Error') / count() * 100 as rate FROM logs.events WHERE timestamp > now() - INTERVAL 24 HOUR GROUP BY time ORDER BY time"
        }
      }
    ]
  },
  "enabled": true,
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

Widget types: `stat`, `line_chart`, `bar_chart`, `table`

Data source types:
- `endpoint` - Reference stored endpoint by name
- `inline` - Direct SQL query (SELECT only)

### Endpoint (Stored Query)

```json
{
  "id": "uuid",
  "name": "errors-by-source",
  "description": "Count errors by source for a time range",
  "sql_query": "SELECT source, count() as count FROM logs.events WHERE level = 'Error' AND timestamp > @from AND timestamp < @to GROUP BY source",
  "parameters": ["from", "to"],
  "cache_ttl_seconds": 60,
  "enabled": true,
  "created_at": "2024-01-01T00:00:00Z"
}
```

Execution: `GET /api/v1/endpoints/errors-by-source?from=2024-01-01&to=2024-01-02`

### Saved Query

```json
{
  "id": "uuid",
  "name": "Production Errors",
  "description": "All errors from production services",
  "filters": {
    "source": "prod-*",
    "level": "Error",
    "search": null,
    "properties": { "env": "production" }
  },
  "created_at": "2024-01-01T00:00:00Z"
}
```

### API Key (Response)

```json
{
  "id": "uuid",
  "name": "claude-integration",
  "scopes": "read,write",
  "enabled": true,
  "created_at": "2024-01-01T00:00:00Z"
}
```

On creation only, includes `api_key` field with the secret (shown once).

---

## Error Format

```json
{
  "error": "error_code",
  "message": "Human-readable description",
  "details": { }
}
```

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `unauthorized` | 401 | Missing or invalid API key |
| `forbidden` | 403 | Key lacks required scope |
| `not_found` | 404 | Resource doesn't exist |
| `validation_error` | 400 | Invalid request body/params |
| `query_error` | 400 | SQL syntax error or disallowed statement |
| `query_timeout` | 408 | Query exceeded 30s limit |
| `rate_limited` | 429 | Too many requests |
| `internal_error` | 500 | Unexpected server error |

Validation error example:

```json
{
  "error": "validation_error",
  "message": "Invalid request",
  "details": {
    "fields": {
      "name": "Required field",
      "sql_query": "Must be a SELECT statement"
    }
  }
}
```

---

## Documentation

1. **OpenAPI spec** at `/api/v1/openapi.json`
2. **Update `/llms.txt`** with API examples and common workflows
3. **Optional**: Swagger UI at `/api/v1/docs`

---

## Implementation Notes

### File Changes

1. **Schema migration**: Add `scopes` column to `logs.api_keys`
2. **Auth middleware**: New `/api/v1/` middleware that validates API keys and scopes
3. **API routes**: New route handlers under `/dashboard/src/app/api/v1/`
4. **Reuse existing**: `lib/clickhouse.ts` functions for all database operations
5. **OpenAPI**: Generate from route definitions or maintain manually

### Key Decisions

- Existing `/api/` routes remain Clerk-protected (web UI)
- New `/api/v1/` routes use API key auth (programmatic access)
- Scopes are additive: `write` includes `read`, `admin` includes `write`
- API keys with no `scopes` value default to `ingest` (backward compatible)
