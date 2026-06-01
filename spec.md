# LogAggregator - Self-Hosted Seq-Compatible Log Aggregation Service

## Overview

A drop-in replacement for Seq (Datalust) that runs entirely self-hosted via Docker Compose. Provides CLEF-compatible ingestion so existing Serilog.Sinks.Seq configurations work with just a URL change.

**Components:**
- **Ingest API** (Go) — CLEF-compatible HTTP endpoints, validates API keys, batch-inserts to ClickHouse
- **ClickHouse** — Columnar storage optimized for time-series log data
- **Dashboard** (NextJS) — Custom dashboards, queries ClickHouse directly
- **Alert Worker** (Go or Node) — Cron-based threshold checking, sends notifications via Resend

**Design Principles:**
- Zero licensing cost (all open source + self-hosted)
- Drop-in Serilog compatibility (change URL only)
- Dashboards and alerts defined in code (no UI for config management)
- Single docker-compose stack, no external dependencies except Resend for email

---

## Architecture

```
                                    Cloudflare Edge
                                    ┌─────────────┐
                                    │  Tunnels    │
             Serilog ──────────────▶│  (TLS/DDoS) │
             Clients                │             │
                                    │ logs.domain │
             Browser ──────────────▶│ dashboard.  │
                                    └──────┬──────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack (Portainer)                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────┐                                                       │
│   │ cloudflared  │ ◀──── outbound connection to Cloudflare               │
│   └──────┬───────┘                                                       │
│          │                                                               │
│          ├─────────────────────┐                                         │
│          ▼                     ▼                                         │
│   ┌──────────────┐      ┌──────────────┐                                │
│   │  Ingest API  │      │   NextJS     │                                │
│   │    (Go)      │      │  Dashboard   │                                │
│   │   :8080      │      │   :3000      │                                │
│   └──────┬───────┘      └──────┬───────┘                                │
│          │                     │                                         │
│          ▼                     ▼                                         │
│   ┌─────────────────────────────────────┐                               │
│   │            ClickHouse               │                               │
│   │         :8123 (HTTP)                │                               │
│   │         :9000 (Native)              │                               │
│   └─────────────────┬───────────────────┘                               │
│                     ▲                                                    │
│                     │                                                    │
│              ┌──────┴───────┐                                           │
│              │ Alert Worker │───────▶ Resend API                        │
│              │   (cron)     │                                           │
│              └──────────────┘                                           │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Notes:
  - No ports exposed to host — all external traffic via Cloudflare Tunnel
  - cloudflared makes outbound connection (no inbound firewall rules needed)
  - ClickHouse never exposed externally
  - Cloudflare provides TLS termination and DDoS protection
```

---

## Docker Compose Structure

Designed for deployment via Portainer with external access through Cloudflare Tunnels. No ports are exposed to the host — all traffic routes through the cloudflared container which connects outbound to Cloudflare's edge.

```yaml
version: '3.8'

services:
  ingest-api:
    build: ./ingest-api
    expose:
      - "8080"    # Internal only, accessed via cloudflared
    environment:
      - CLICKHOUSE_HOST=clickhouse
      - CLICKHOUSE_PORT=9000
      - CLICKHOUSE_DATABASE=logs
    depends_on:
      - clickhouse
    restart: unless-stopped

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    expose:
      - "8123"    # HTTP interface (internal only)
      - "9000"    # Native protocol (internal only)
    volumes:
      - clickhouse-data:/var/lib/clickhouse
      - ./clickhouse/init:/docker-entrypoint-initdb.d
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    restart: unless-stopped

  dashboard:
    build: ./dashboard
    expose:
      - "3000"    # Internal only, accessed via cloudflared
    environment:
      - CLICKHOUSE_URL=http://clickhouse:8123
    depends_on:
      - clickhouse
    restart: unless-stopped

  alert-worker:
    build: ./alert-worker
    environment:
      - CLICKHOUSE_HOST=clickhouse
      - CLICKHOUSE_PORT=9000
      - CLICKHOUSE_DATABASE=logs
      - RESEND_API_KEY=${RESEND_API_KEY}
    volumes:
      - ./alert-worker/alerts.json:/app/alerts.json:ro
    depends_on:
      - clickhouse
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - ingest-api
      - dashboard
    restart: unless-stopped

volumes:
  clickhouse-data:
```

### Cloudflare Tunnel Configuration

In Cloudflare Zero Trust dashboard (Access → Tunnels), configure the following public hostnames for your tunnel:

| Public Hostname | Service | Description |
|-----------------|---------|-------------|
| `logs.yourdomain.com` | `http://ingest-api:8080` | CLEF ingestion endpoint for Serilog clients |
| `logs-dashboard.yourdomain.com` | `http://dashboard:3000` | NextJS dashboard UI |

**Security Notes:**
- The ingest endpoint (`logs.yourdomain.com`) should be publicly accessible for your apps to send logs
- Consider adding Cloudflare Access policies to the dashboard hostname to restrict who can view logs
- ClickHouse is never exposed externally — all queries go through the dashboard or alert-worker

---

## ClickHouse Schema

Place in `./clickhouse/init/001_schema.sql` for automatic execution on first startup.

```sql
-- Create database
CREATE DATABASE IF NOT EXISTS logs;

-- API keys for authentication
CREATE TABLE IF NOT EXISTS logs.api_keys (
    key_id UUID DEFAULT generateUUIDv4(),
    api_key String,                          -- The actual key value (store as-is, compare with constant-time)
    name String,                             -- Human-readable identifier (e.g., "order-service", "payment-api")
    created_at DateTime64(3) DEFAULT now(),
    enabled UInt8 DEFAULT 1                  -- 1 = active, 0 = disabled
) ENGINE = MergeTree
ORDER BY api_key;

-- Main logs table
CREATE TABLE IF NOT EXISTS logs.events (
    id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3),                 -- @t from CLEF
    level LowCardinality(String),            -- @l: Debug, Information, Warning, Error, Fatal
    message_template String,                 -- @mt: Original template with placeholders
    message String,                          -- @m: Rendered message (may be empty if @mt only)
    exception String DEFAULT '',             -- @x: Exception/stack trace
    event_type String DEFAULT '',            -- @i: MurmurHash3 32-bit hex hash of message_template (auto-computed at ingest if not provided)
    source String,                           -- Derived from API key name
    properties String                        -- JSON string of all other CLEF properties
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (source, toStartOfHour(timestamp), level);

-- Index for common query patterns
ALTER TABLE logs.events ADD INDEX idx_level (level) TYPE set(5) GRANULARITY 1;
ALTER TABLE logs.events ADD INDEX idx_message (message) TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 1;
```

### Schema Notes

- **Partitioning by day** enables efficient time-range queries and future data lifecycle management
- **ORDER BY (source, timestamp, level)** optimizes the most common query pattern: "show me logs from service X in time range Y"
- **LowCardinality(String)** for level provides ~10x compression since there are only ~5 distinct values
- **properties as JSON string** — ClickHouse can query into it with `JSONExtract*` functions; avoids schema complexity for varying log properties

---

## Ingest API Specification

### Technology
- **Language:** Go
- **Dependencies:** ClickHouse Go driver, standard library HTTP server
- **No web framework needed** — stdlib `net/http` is sufficient

### Endpoints

#### `POST /ingest/clef`
Modern Seq-compatible endpoint.

#### `POST /api/events/raw?clef`
Legacy Seq-compatible endpoint. Behaves identically to `/ingest/clef`.

Both endpoints accept the same request format and return the same responses.

### Request Format

**Headers:**
- `Content-Type: application/vnd.serilog.clef` (preferred) or `text/plain` (accepted)
- `X-Seq-ApiKey: <api-key>` — API key for authentication

**Alternative Auth:**
- Query parameter: `?apiKey=<api-key>`
- Header takes precedence if both provided

**Body:**
Newline-delimited JSON (CLEF format). Each line is an independent log event.

```
{"@t":"2026-01-25T10:30:00.123Z","@mt":"User {UserId} logged in","@l":"Information","UserId":12345,"Browser":"Chrome"}
{"@t":"2026-01-25T10:30:01.456Z","@mt":"Order {OrderId} processed","OrderId":789,"Amount":99.99}
{"@t":"2026-01-25T10:30:02.789Z","@mt":"Payment failed","@l":"Error","@x":"System.Exception: Card declined\n   at PaymentService.Process()"}
```

### CLEF Field Mapping

| CLEF Field | ClickHouse Column | Notes |
|------------|-------------------|-------|
| `@t` | `timestamp` | Required. ISO 8601 format. |
| `@l` | `level` | Optional. Defaults to "Information" if missing. |
| `@mt` | `message_template` | Message template with placeholders like `{UserId}` |
| `@m` | `message` | Rendered message. If missing, use `@mt` value. |
| `@x` | `exception` | Exception text/stack trace |
| `@i` | `event_type` | Event type identifier. If omitted, auto-computed as MurmurHash3 32-bit hex of `@mt` (e.g. `0x5432a8ff`). Events with the same template share the same event type. |
| *(all others)* | `properties` | Serialized as JSON object |

**Source derivation:** The `source` column is populated from the `name` field of the matched API key, not from the log event itself.

### Response Format

**Success (201 Created):**
```json
{"MinimumLevelAccepted": null}
```

The `MinimumLevelAccepted` field exists for Seq client compatibility. Return `null` to accept all levels. Future enhancement: implement dynamic level filtering per API key.

**Validation Error (400 Bad Request):**
```json
{"Error": "Line 3: invalid JSON"}
```

**Authentication Error (401 Unauthorized):**
```json
{"Error": "API key required"}
```

**Authorization Error (403 Forbidden):**
```json
{"Error": "Invalid or disabled API key"}
```

### Ingestion Logic

```
1. Extract API key from X-Seq-ApiKey header or apiKey query param
2. If no key provided → 401
3. Look up key in api_keys table (use constant-time comparison)
4. If key not found or enabled = 0 → 403
5. Read request body
6. Split body by newlines
7. For each non-empty line:
   a. Parse as JSON
   b. Extract CLEF fields (@t, @l, @mt, @m, @x, @i)
   c. Validate @t exists and is valid timestamp → skip line if invalid
   d. Collect remaining fields into properties JSON
   e. Add to batch
8. Insert batch into ClickHouse
9. Return 201 with MinimumLevelAccepted response
```

### Batching Strategy

Buffer incoming events and flush to ClickHouse when either condition is met:
- **1000 events** accumulated, OR
- **1 second** since last flush

This balances latency (logs visible within 1 second) with efficiency (batch inserts).

### Health Check Endpoint

#### `GET /health`

Returns `200 OK` with body `{"status": "ok"}` if the service can connect to ClickHouse.
Returns `503 Service Unavailable` if ClickHouse connection fails.

---

## Dashboard (NextJS)

### Technology
- **Framework:** NextJS 14+ with App Router
- **Styling:** Tailwind CSS
- **Charts:** Recharts or similar (add as needed)

### ClickHouse Queries

Query ClickHouse directly from Server Components or API routes using the HTTP interface:

```typescript
// lib/clickhouse.ts
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';

export async function queryClickHouse<T>(sql: string): Promise<T[]> {
  const response = await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: `${sql} FORMAT JSON`,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store'
  });
  
  if (!response.ok) {
    throw new Error(`ClickHouse query failed: ${await response.text()}`);
  }
  
  const result = await response.json();
  return result.data;
}
```

### Example Queries

**Recent logs from a service:**
```sql
SELECT timestamp, level, message, properties
FROM logs.events
WHERE source = 'order-service'
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC
LIMIT 100
```

**Error count by service (last 24 hours):**
```sql
SELECT source, count(*) as error_count
FROM logs.events
WHERE level IN ('Error', 'Fatal')
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY source
ORDER BY error_count DESC
```

**Logs by property value:**
```sql
SELECT timestamp, level, message, properties
FROM logs.events
WHERE JSONExtractString(properties, 'UserId') = '12345'
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC
```

**Timeseries of log volume:**
```sql
SELECT 
  toStartOfMinute(timestamp) as minute,
  count(*) as count,
  countIf(level = 'Error') as errors
FROM logs.events
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute
```

### Dashboard Pages (Build As Needed)

No predefined dashboard spec. Build pages with Claude Code as requirements emerge. Suggested starting points:

1. **Log Explorer** — Search/filter logs, view details, expand properties
2. **Service Overview** — Log volume and error rates per source
3. **Live Tail** — Polling-based real-time log view

---

## Alert Worker

### Technology
- **Language:** Go (same as ingest API) or Node.js
- **Scheduling:** Internal ticker/cron loop
- **Email:** Resend API

### Configuration

Alerts defined in `alerts.json`:

```json
{
  "alerts": [
    {
      "id": "high-error-rate",
      "name": "High Error Rate",
      "description": "More than 50 errors in 5 minutes",
      "query": "SELECT count(*) as cnt FROM logs.events WHERE level IN ('Error', 'Fatal') AND timestamp > now() - INTERVAL 5 MINUTE",
      "condition": "cnt > 50",
      "interval_seconds": 60,
      "cooldown_seconds": 300,
      "recipients": ["ops@example.com"],
      "subject": "[ALERT] High error rate detected"
    },
    {
      "id": "payment-failures",
      "name": "Payment Service Failures",
      "description": "Any fatal errors from payment service",
      "query": "SELECT count(*) as cnt FROM logs.events WHERE source = 'payment-service' AND level = 'Fatal' AND timestamp > now() - INTERVAL 5 MINUTE",
      "condition": "cnt > 0",
      "interval_seconds": 60,
      "cooldown_seconds": 600,
      "recipients": ["payments-team@example.com", "ops@example.com"],
      "subject": "[CRITICAL] Payment service fatal error"
    },
    {
      "id": "service-quiet",
      "name": "Service Gone Quiet",
      "description": "No logs from order-service in 10 minutes",
      "query": "SELECT count(*) as cnt FROM logs.events WHERE source = 'order-service' AND timestamp > now() - INTERVAL 10 MINUTE",
      "condition": "cnt == 0",
      "interval_seconds": 120,
      "cooldown_seconds": 1800,
      "recipients": ["ops@example.com"],
      "subject": "[ALERT] order-service has stopped logging"
    }
  ]
}
```

### Alert Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the alert |
| `name` | string | Human-readable name |
| `description` | string | What this alert detects |
| `query` | string | ClickHouse SQL query. Must return a single row with named columns. |
| `condition` | string | JavaScript-style expression evaluated against query result. Supports: `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `\|\|` |
| `interval_seconds` | int | How often to check (minimum 30) |
| `cooldown_seconds` | int | Minimum time between notifications for same alert |
| `recipients` | string[] | Email addresses to notify |
| `subject` | string | Email subject line |

### Worker Logic

```
1. Load alerts.json on startup
2. Initialize state map: alertId → { lastRun: time, lastTriggered: time }
3. Loop forever:
   a. For each alert:
      - If now - lastRun < interval_seconds → skip
      - Execute query against ClickHouse
      - Evaluate condition against result row
      - If condition is true AND (now - lastTriggered > cooldown_seconds):
        - Send email via Resend
        - Update lastTriggered
      - Update lastRun
   b. Sleep 1 second
```

### Resend Integration

```go
// Minimal Resend API call
func sendAlert(apiKey string, to []string, subject string, body string) error {
    payload := map[string]interface{}{
        "from":    "alerts@yourdomain.com",
        "to":      to,
        "subject": subject,
        "text":    body,
    }
    
    jsonBody, _ := json.Marshal(payload)
    req, _ := http.NewRequest("POST", "https://api.resend.com/emails", bytes.NewBuffer(jsonBody))
    req.Header.Set("Authorization", "Bearer "+apiKey)
    req.Header.Set("Content-Type", "application/json")
    
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    
    if resp.StatusCode >= 400 {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("resend error: %s", body)
    }
    return nil
}
```

### Email Body Template

```
Alert: {name}
Time: {timestamp}
Description: {description}

Query Result:
{formatted query result}

Query:
{query}
```

---

## API Key Management

No UI for API key management. Use ClickHouse client directly.

### Create API Key

```sql
INSERT INTO logs.api_keys (api_key, name) 
VALUES ('your-generated-key-here', 'order-service');
```

Generate keys with: `openssl rand -hex 32`

### List API Keys

```sql
SELECT key_id, name, created_at, enabled 
FROM logs.api_keys 
ORDER BY created_at;
```

### Disable API Key

```sql
ALTER TABLE logs.api_keys 
UPDATE enabled = 0 
WHERE name = 'old-service';
```

### Delete API Key

```sql
ALTER TABLE logs.api_keys 
DELETE WHERE name = 'old-service';
```

---

## Client Configuration

### Serilog (existing Seq sink)

Just change the server URL to your Cloudflare tunnel hostname:

```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.Seq(
        serverUrl: "https://logs.yourdomain.com",  // Your Cloudflare tunnel hostname
        apiKey: "your-api-key-here"
    )
    .CreateLogger();
```

### Serilog (appsettings.json)

```json
{
  "Serilog": {
    "WriteTo": [
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "https://logs.yourdomain.com",
          "apiKey": "your-api-key-here"
        }
      }
    ]
  }
}
```

No code changes required if already using Serilog.Sinks.Seq — just update the URL.

---

## Directory Structure

```
logaggregator/
├── docker-compose.yml
├── .env.example                 # RESEND_API_KEY=re_xxx
│                                # CLOUDFLARE_TUNNEL_TOKEN=eyJ...
├── clickhouse/
│   └── init/
│       └── 001_schema.sql       # Database schema
├── ingest-api/
│   ├── Dockerfile
│   ├── go.mod
│   ├── go.sum
│   └── main.go
├── dashboard/
│   ├── Dockerfile
│   ├── package.json
│   ├── next.config.js
│   ├── tailwind.config.js
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx         # Log explorer
│       │   └── ...
│       └── lib/
│           └── clickhouse.ts    # Query helper
└── alert-worker/
    ├── Dockerfile
    ├── go.mod (or package.json)
    ├── main.go (or index.ts)
    └── alerts.json              # Alert definitions
```

---

## Environment Variables

### Stack-level (.env file)
| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | Resend API key for alert emails |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token from Cloudflare Zero Trust tunnel setup |

### Ingest API
| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKHOUSE_HOST` | `clickhouse` | ClickHouse hostname |
| `CLICKHOUSE_PORT` | `9000` | ClickHouse native port |
| `CLICKHOUSE_DATABASE` | `logs` | Database name |
| `PORT` | `8080` | HTTP server port |

### Dashboard
| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKHOUSE_URL` | `http://clickhouse:8123` | ClickHouse HTTP URL |

### Alert Worker
| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKHOUSE_HOST` | `clickhouse` | ClickHouse hostname |
| `CLICKHOUSE_PORT` | `9000` | ClickHouse native port |
| `CLICKHOUSE_DATABASE` | `logs` | Database name |
| `RESEND_API_KEY` | (required) | Resend API key |
| `ALERT_FROM_EMAIL` | `alerts@yourdomain.com` | From address for alerts |

---

## Deployment

### Prerequisites
1. Portainer running on your server
2. Cloudflare account with a domain
3. Resend account for alert emails

### Cloudflare Tunnel Setup

1. Go to Cloudflare Zero Trust → Networks → Tunnels
2. Create a new tunnel, name it (e.g., "logaggregator")
3. Copy the tunnel token (starts with `eyJ...`)
4. Add public hostnames:
   - `logs.yourdomain.com` → `http://ingest-api:8080`
   - `logs-dashboard.yourdomain.com` → `http://dashboard:3000`
5. (Optional) Add Cloudflare Access policy to dashboard hostname for authentication

### Portainer Deployment

1. In Portainer, go to Stacks → Add stack
2. Name it "logaggregator"
3. Paste the docker-compose.yml content
4. Add environment variables:
   - `RESEND_API_KEY` = your Resend API key
   - `CLOUDFLARE_TUNNEL_TOKEN` = your tunnel token from step 3 above
5. Deploy the stack

### Create First API Key

Once the stack is running, open Portainer console for the clickhouse container (or SSH to host):

```bash
# Generate and insert API key
docker exec -it logaggregator_clickhouse_1 clickhouse-client -q \
  "INSERT INTO logs.api_keys (api_key, name) VALUES ('$(openssl rand -hex 32)', 'my-first-app')"

# View the generated key
docker exec -it logaggregator_clickhouse_1 clickhouse-client -q \
  "SELECT api_key, name FROM logs.api_keys"
```

### Verify It Works

```bash
# Send a test log (use your actual domain and API key)
curl -X POST https://logs.yourdomain.com/ingest/clef \
  -H "Content-Type: application/vnd.serilog.clef" \
  -H "X-Seq-ApiKey: YOUR_API_KEY" \
  -d '{"@t":"2026-01-25T12:00:00Z","@mt":"Test log message","@l":"Information"}'

# Should return: {"MinimumLevelAccepted":null}

# Check it arrived
docker exec -it logaggregator_clickhouse_1 clickhouse-client -q \
  "SELECT * FROM logs.events FORMAT Vertical"
```

Then visit `https://logs-dashboard.yourdomain.com` to see the dashboard.

---

## Per-Service Data Retention

Each API key (i.e. each log source) has a `retention_days` setting on `logs.api_keys`
(`0` = keep forever, the default). The `retention-worker` service runs a trim pass on
startup and every `RETENTION_INTERVAL_HOURS` (default 24): for each enabled key with
`retention_days > 0`, it issues
`ALTER TABLE logs.events DELETE WHERE source = '<name>' AND timestamp < now() - INTERVAL <N> DAY`.
Set retention per service inline on the **API Keys** page in the dashboard.

Per-source `ALTER ... DELETE` mutations are used (rather than native ClickHouse `TTL` or
`DROP PARTITION`) because `logs.events` is partitioned by day across all sources, so a
partition spans every service and can't be dropped per-source; a table-level `TTL` likewise
can't vary by source. Policy edits take effect on the next pass.

## Future Enhancements (Out of Scope for v1)

- Log level filtering per API key (use MinimumLevelAccepted)
- Full-text search with ClickHouse text indexes
- Materialized views for extracted properties (faster property queries)
- Grafana integration (ClickHouse datasource)
- Metrics endpoint (Prometheus format)
- Structured alerting (PagerDuty, Slack webhooks)
- Multi-node ClickHouse cluster for HA
- Authentication for dashboard
- API key management UI