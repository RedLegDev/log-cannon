# Log-Cannon

A self-hosted, open-source alternative to [Seq](https://datalust.co/seq) for log aggregation and analysis. Drop-in compatible with `Serilog.Sinks.Seq` — just change the server URL.

## Features

- **Seq-Compatible**: Works with existing Serilog configurations (CLEF format)
- **High Performance**: ClickHouse columnar storage optimized for time-series data
- **Web Dashboard**: Search, filter, and explore logs with property-based filtering
- **Threshold Alerts**: Define conditions and get email notifications via Resend
- **Secure Access**: Cloudflare Tunnels for TLS and DDoS protection
- **API Key Management**: Per-application key isolation and tracking

## Architecture

```
Serilog Clients ──► Cloudflare Tunnel ──► Ingest API (Go) ──► ClickHouse
                                              │
Browser ──────────► Cloudflare Tunnel ──► Dashboard (Next.js) ─┘
                                              │
                         Alert Worker (Go) ───┴──► Resend (Email)
```

### Edge Ingestion (Optional — Cloudflare Workers)

For redundant ingestion that survives internet outages, deploy the Cloudflare Workers architecture. Logs are accepted at the edge, buffered in a Cloudflare Queue, and drained into ClickHouse by a consumer on your server.

```
Serilog / OTel / Webhooks
        │
        ▼
┌─ Cloudflare Edge ────────────────────────┐
│  Ingest Worker ──────────► CF Queue      │
│  (CLEF, webhook, OTel)     (buffered)    │
│  API Keys: KV Namespace                  │
└──────────────────────────┬───────────────┘
                           │ pull
                           ▼
┌─ Your Server ────────────────────────────┐
│  Queue Consumer (Go) ──► ClickHouse      │
│  Dashboard (Next.js)                     │
│  Alert Worker (Go)                       │
└──────────────────────────────────────────┘
```

When your server goes offline, the Workers keep accepting logs and the Queue buffers them (up to 4 days). When connectivity returns, the consumer drains the backlog.

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Cloudflare account with a domain
- Resend account for alert emails

### Setup

```bash
# Clone and configure
git clone <repo-url>
cd log-cannon
cp .env.example .env
# Edit .env with your RESEND_API_KEY and CLOUDFLARE_TUNNEL_TOKEN

# Start services
docker-compose up -d
```

### Cloudflare Tunnel Configuration

1. Go to Cloudflare Zero Trust → Networks → Tunnels
2. Create a tunnel named "log-cannon"
3. Copy the token to `.env` as `CLOUDFLARE_TUNNEL_TOKEN`
4. Add public hostnames:
   - `logs.yourdomain.com` → `http://ingest-api:8080`
   - `logs-dashboard.yourdomain.com` → `http://dashboard:3000`

### Create an API Key

```bash
docker exec -it log-cannon-clickhouse-1 clickhouse-client -q \
  "INSERT INTO logs.api_keys (api_key, name) VALUES ('$(openssl rand -hex 32)', 'my-app')"
```

### Discovery Mode (Migration from Seq)

If you're migrating from Seq and don't have access to your existing API keys, enable **Discovery Mode** to auto-provision unknown keys:

```bash
# In .env or docker-compose
DISCOVERY_MODE=true
```

When enabled:
- Unknown API keys are automatically created as sources
- Source names use format `discovered-{key-prefix}` (first 8 chars)
- Logs are accepted immediately (no 403 errors)
- Discovered keys appear in the API Keys management UI

**Migration workflow:**
1. Set `DISCOVERY_MODE=true` and restart ingest-api
2. Point your apps to Log-Cannon (same endpoint format as Seq)
3. Apps send logs → keys auto-provision
4. Review discovered sources in dashboard, rename as needed
5. Set `DISCOVERY_MODE=false` when migration complete

## Client Configuration

### Serilog (C#)

```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.Seq(
        serverUrl: "https://logs.yourdomain.com",
        apiKey: "your-api-key-here"
    )
    .CreateLogger();
```

### appsettings.json

```json
{
  "Serilog": {
    "WriteTo": [{
      "Name": "Seq",
      "Args": {
        "serverUrl": "https://logs.yourdomain.com",
        "apiKey": "your-api-key-here"
      }
    }]
  }
}
```

## Project Structure

```
log-cannon/
├── ingest-api/        # Go HTTP server for CLEF log ingestion (direct mode)
├── workers/           # Cloudflare Workers for edge ingestion (optional)
│   └── packages/
│       ├── shared/          # Shared types and auth utilities
│       └── ingest/          # Unified ingest worker (CLEF, webhook, OTel)
├── queue-consumer/    # Go service that pulls from CF Queue → ClickHouse
├── dashboard/         # Next.js web UI for log exploration
├── alert-worker/      # Go service for threshold-based alerting
├── clickhouse/        # Database schema initialization
├── backup/            # Automated backup with Cloudflare R2 offsite sync
└── docker-compose.yml
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Resend API key for alert emails |
| `CLOUDFLARE_TUNNEL_TOKEN` | Yes | Cloudflare tunnel token |
| `ALERT_FROM_EMAIL` | No | Sender email for alerts |
| `DISCOVERY_MODE` | No | Set to `true` to auto-provision unknown API keys (for migration) |

### Queue Consumer Variables (for edge ingestion)

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `CF_QUEUE_ID` | Yes | Cloudflare Queue ID (from queue setup) |
| `CF_API_TOKEN` | Yes | Cloudflare API token with Queue read/ack permissions |
| `CLICKHOUSE_HOST` | No | ClickHouse host (default: `clickhouse`) |
| `CLICKHOUSE_PORT` | No | ClickHouse native port (default: `9000`) |

## Alerts

Configure alerts in `alert-worker/alerts.json`:

```json
{
  "id": "high-error-rate",
  "name": "High Error Rate",
  "query": "SELECT count() as cnt FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 5 MINUTE",
  "condition": "cnt > 50",
  "interval_seconds": 60,
  "cooldown_seconds": 300,
  "recipients": ["alerts@example.com"],
  "subject": "High error rate detected"
}
```

## Custom Dashboards

Create custom dashboards with configurable widgets for visualizing your log data.

### Widget Types

| Type | Description | Configuration |
|------|-------------|---------------|
| `stat` | Single KPI metric display | `valueField`, `format` (number/percent/duration), `trend` |
| `line_chart` | Time-series line chart | `xField`, `yField` (string or array), `colors` |
| `bar_chart` | Categorical bar chart | `xField`, `yField` (string or array), `colors` |
| `pie_chart` | Proportional pie chart | `xField` (label field), `yField` (value field), `colors` |
| `doughnut_chart` | Pie chart with center hole | `xField` (label field), `yField` (value field), `colors` |
| `scatter_chart` | Correlation scatter plot | `xField` (numeric), `yField` (numeric), `colors` |
| `table` | Sortable data table | `columns`, `sortBy` |

### Dashboard Configuration Example

```json
{
  "layout": "auto",
  "widgets": [
    {
      "id": "errors-by-source",
      "type": "pie_chart",
      "title": "Errors by Source",
      "dataSource": {
        "sql": "SELECT source as name, count() as count FROM logs.events WHERE level = 'Error' AND timestamp > now() - INTERVAL 24 HOUR GROUP BY source"
      },
      "visualization": {
        "xField": "name",
        "yField": "count",
        "colors": ["#FF4D2A", "#FF3366", "#36A2EB", "#FFCE56"]
      }
    },
    {
      "id": "log-volume",
      "type": "line_chart",
      "title": "Log Volume (24h)",
      "dataSource": {
        "sql": "SELECT toStartOfHour(timestamp) as time, count() as count FROM logs.events WHERE timestamp > now() - INTERVAL 24 HOUR GROUP BY time ORDER BY time"
      },
      "visualization": {
        "xField": "time",
        "yField": "count"
      }
    }
  ]
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ingest/clef` | POST | Primary CLEF ingestion endpoint |
| `/api/events/raw?clef` | POST | Legacy Seq-compatible endpoint |
| `/health` | GET | Health check |
| `/api/v1/*` | Various | REST API (see `/llms.txt/api` for full reference) |
| `/api/mcp` | POST | MCP server (Model Context Protocol) |

## MCP Server

Log Cannon exposes its API as an [MCP](https://modelcontextprotocol.io) server at `/api/mcp`, allowing AI assistants and other MCP-compatible clients to discover and use Log Cannon's tools directly.

### MCP Client Configuration

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "log-cannon": {
      "type": "http",
      "url": "https://your-instance/api/mcp",
      "headers": { "X-Api-Key": "your-api-key" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "log-cannon": {
      "type": "http",
      "url": "https://your-instance/api/mcp",
      "headers": { "X-Api-Key": "your-api-key" }
    }
  }
}
```

The MCP endpoint uses the same API key auth as the REST API. Tools are scoped to your key's permissions (`read` or `write`). See the **MCP** page in the dashboard for interactive setup instructions.

## Backup & Restore

Automated ClickHouse backups run twice daily with offsite sync to Cloudflare R2.

### Setup Cloudflare R2

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Go to **R2 Object Storage** → **Create bucket**
3. Name it `log-cannon-backups` (or your preference)
4. Go to **R2 Object Storage** → **Manage R2 API Tokens** → **Create API Token**
5. Give it **Object Read & Write** permission on your bucket
6. Note the **Account ID** (on the R2 overview page), **Access Key ID**, and **Secret Access Key**

Add to your `.env`:

```env
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET=log-cannon-backups
```

Then rebuild: `docker compose build backup && docker compose up -d backup`

### Backup Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_CRON` | `0 3,15 * * *` | Cron schedule (default: 3 AM and 3 PM) |
| `BACKUP_RETAIN_LOCAL` | `7` | Local backups to keep |
| `BACKUP_RETAIN_OFFSITE` | `14` | R2 backups to keep |
| `R2_ACCOUNT_ID` | | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | | R2 API token secret key |
| `R2_BUCKET` | `log-cannon-backups` | R2 bucket name |

### Manual Backup

```bash
docker compose exec backup /scripts/backup.sh
```

### List Available Backups

```bash
docker compose exec backup /scripts/restore.sh
```

### Restore

```bash
# From local backup
docker compose exec backup /scripts/restore.sh logs-2026-03-15-030000

# From R2 (auto-downloads if not found locally)
docker compose exec backup /scripts/restore.sh logs-2026-03-01-030000
```

### Disaster Recovery (fresh server)

1. Set up a new server with Docker Compose
2. Clone this repo and configure `.env` with your R2 credentials
3. `docker compose up -d`
4. Wait for ClickHouse to be healthy, then:

```bash
docker compose exec backup /scripts/restore.sh logs-2026-03-15-030000
```

The restore script downloads from R2 automatically if the backup isn't found locally.

Backup status is also visible in the dashboard under **System → Backups**.

## Cloudflare Workers Edge Ingestion (Optional)

This optional architecture adds ingestion redundancy by accepting logs at Cloudflare's edge. Thin Workers validate API keys and enqueue raw payloads — all parsing happens in the Go queue consumer on your server.

### Prerequisites

- Cloudflare account with a domain (Workers free tier is sufficient)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- [pnpm](https://pnpm.io/) for the Workers monorepo

### Step 1: Create Cloudflare Resources

**Create a Queue:**

```bash
npx wrangler queues create log-cannon-ingest
```

Note the **Queue ID** from the output — you'll need it for the consumer.

**Create a KV Namespace:**

```bash
npx wrangler kv namespace create API_KEYS
```

Note the **namespace ID** from the output.

### Step 2: Populate API Keys in KV

For each API key, add an entry to KV. The key is the raw API key string, the value is JSON with the source name:

```bash
# Example: add a key for your "order-service"
npx wrangler kv key put --namespace-id=YOUR_KV_NAMESPACE_ID \
  "your-api-key-here" '{"name":"order-service","enabled":true}'
```

To bulk-sync from your existing ClickHouse `api_keys` table:

```bash
docker exec log-cannon-clickhouse-1 clickhouse-client -q \
  "SELECT api_key, name FROM logs.api_keys WHERE enabled = 1 FORMAT JSONEachRow" \
  | while IFS= read -r row; do
      key=$(echo "$row" | jq -r .api_key)
      name=$(echo "$row" | jq -r .name)
      npx wrangler kv key put --namespace-id=YOUR_KV_NAMESPACE_ID \
        "$key" "{\"name\":\"$name\",\"enabled\":true}"
    done
```

### Step 3: Configure the Worker

Update `workers/packages/ingest/wrangler.toml` with your KV namespace ID and route patterns:

```toml
[[kv_namespaces]]
binding = "API_KEYS"
id = "YOUR_KV_NAMESPACE_ID"    # ← replace

routes = [
  { pattern = "logs.yourdomain.com/ingest/*", zone_name = "yourdomain.com" },
  { pattern = "logs.yourdomain.com/api/events/raw", zone_name = "yourdomain.com" },
  { pattern = "logs.yourdomain.com/v1/*", zone_name = "yourdomain.com" },
]
```

### Step 4: Deploy the Worker

```bash
cd workers

# Install dependencies
pnpm install

# Deploy
cd packages/ingest && pnpm wrangler deploy
```

### Step 5: Start the Queue Consumer

Add the Cloudflare credentials to your `.env`:

```env
CF_ACCOUNT_ID=your-cloudflare-account-id
CF_QUEUE_ID=your-queue-id-from-step-1
CF_API_TOKEN=your-api-token-with-queue-permissions
```

The API token needs the **Queues: Read** permission. Create one at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens).

Then start the consumer:

```bash
docker compose up -d queue-consumer
```

### Step 6: Verify

Send a test log through the Worker endpoint:

```bash
curl -X POST https://logs.yourdomain.com/ingest/clef \
  -H "X-Seq-ApiKey: your-api-key" \
  -d '{"@t":"2026-01-01T00:00:00Z","@mt":"Hello from edge","@l":"Information"}'
```

Check the queue consumer logs:

```bash
docker compose logs -f queue-consumer
```

### Ingest Routes

A single Worker handles all ingestion formats via path-based routing:

| Path | Format | Notes |
|------|--------|-------|
| `/ingest/clef` | CLEF (NDJSON) | Primary Seq/Serilog endpoint |
| `/api/events/raw` | CLEF (NDJSON) | Legacy Seq compatibility |
| `/ingest/webhook` | Webhook JSON | Supports `?preset=cloudflare` |
| `/ingest/otlp/logs` | OTel logs | Protobuf or JSON |
| `/ingest/otlp/traces` | OTel traces | Protobuf or JSON |
| `/v1/logs` | OTel logs | Standard OTel SDK path |
| `/v1/traces` | OTel traces | Standard OTel SDK path |
| `/health` | — | Returns `{"status":"ok"}` |

### How It Works

1. **Worker** is thin — it validates the API key against KV, reads the raw request body, and pushes it to the Queue with metadata (format, source, content-type)
2. **Queue** buffers messages at the edge for up to 4 days
3. **Queue Consumer** polls the Cloudflare Queue API, decodes the raw payloads, parses them using the same logic as the direct ingest-api (CLEF, webhook presets, OTel protobuf/JSON), and batch-inserts into ClickHouse

The existing direct ingest-api continues to work — the Worker is an additional ingestion path, not a replacement.

## Tech Stack

- **Ingest API**: Go 1.22+
- **Edge Workers**: Cloudflare Workers (TypeScript)
- **Queue Consumer**: Go 1.22+
- **Dashboard**: Next.js, React 18, Tailwind CSS
- **Alert Worker**: Go 1.22+
- **Database**: ClickHouse
- **Infrastructure**: Docker Compose, Cloudflare Tunnels, Cloudflare Queues + KV (optional)

## License

MIT
