# Log Cannon

A self-hosted, open-source alternative to [Seq](https://datalust.co/seq) for log aggregation and analysis. Drop-in compatible with `Serilog.Sinks.Seq` — point your existing sink at Log Cannon and keep shipping CLEF.

- **Seq-compatible ingestion** — works with existing Serilog/CLEF configurations, plus webhook and OpenTelemetry (logs + traces) endpoints.
- **Edge ingestion that survives outages** — logs are accepted at the Cloudflare edge and buffered in a queue, so nothing is dropped while your server is offline.
- **ClickHouse storage** — columnar storage tuned for high-volume time-series log data.
- **Web dashboard** — search, filter, and explore logs; build custom widget dashboards; manage API keys.
- **Threshold alerts** — define SQL conditions and get email when they trip.
- **Per-service retention, backups, MCP** — retention windows per source, twice-daily backups with offsite R2 sync, and an MCP server for AI assistants.

## Architecture

Log Cannon is a small monorepo of services. Ingestion rides the Cloudflare edge; everything else runs on your own server via Docker Compose.

```
Serilog / OTel / Webhooks
        │
        ▼
┌─ Cloudflare edge ─────────────────────────┐
│  Ingest Worker ───────────► CF Queue      │   validates API key (KV),
│  (CLEF · webhook · OTel)    (buffers ≤4d)  │   enqueues the raw payload
└──────────────────────────┬────────────────┘
                           │ pull
                           ▼
┌─ Your server (Docker Compose) ────────────┐
│  Queue Consumer (Go) ──► ClickHouse        │   parses CLEF/webhook/OTel,
│  Dashboard (Next.js) ──► reads ClickHouse  │   batch-inserts
│  Alert Worker (Go) ────► email             │
│  Retention Worker (Go) ─► trims ClickHouse │
│  Backup ───────────────► Cloudflare R2     │
│                                            │
│  Access via Cloudflare Tunnel (TLS/DDoS)   │
└────────────────────────────────────────────┘
```

The Worker is deliberately thin — it only authenticates the request against a KV namespace and pushes the raw body to the queue. All parsing happens in the Go queue consumer on your server, using the same code paths regardless of source format. When your server goes offline the Worker keeps accepting logs and the queue holds them (up to 4 days) until the consumer drains the backlog.

> **Cloudflare is a hard dependency.** Ingestion requires a Cloudflare account with Workers and Queues; access uses a Cloudflare Tunnel. Storage, the dashboard, alerting, retention, and backups are fully self-hosted.

## Quick Start

### Prerequisites

- Docker & Docker Compose
- A Cloudflare account with a domain (Workers free tier is sufficient)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and [pnpm](https://pnpm.io/) to deploy the ingest Worker
- An SMTP provider (or HTTP email API) for alert and sign-in emails — optional for local dev, where a bundled mailbox catches everything

### 1. Configure and start the server

```bash
git clone <repo-url>
cd log-cannon
cp .env.example .env
# Edit .env — at minimum set AUTH_SECRET and AUTH_ALLOWED_EMAILS,
# plus CLOUDFLARE_TUNNEL_TOKEN and your email settings (see below).

docker compose up -d
```

This brings up ClickHouse, the dashboard, the alert/retention/backup workers, and the queue consumer. For local development, add `COMPOSE_PROFILES=dev` to also start a bundled [Inbucket](https://inbucket.org) mailbox (read captured emails at `http://localhost:9000`).

### 2. Deploy the ingest Worker

The Worker is what your log clients actually talk to. See [Edge Ingestion Setup](#edge-ingestion-setup) below for the full walkthrough (create a Queue + KV namespace, populate API keys, deploy).

### 3. Point a client at it

```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.Seq(
        serverUrl: "https://logs.yourdomain.com",
        apiKey: "your-api-key-here")
    .CreateLogger();
```

Or in `appsettings.json`:

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

## Access (Cloudflare Tunnel)

The dashboard and any direct-to-server endpoints are exposed via a Cloudflare Tunnel, which provides TLS and DDoS protection without opening inbound ports.

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel** (name it `log-cannon`).
2. Copy the token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Add a public hostname: `logs-dashboard.yourdomain.com` → `http://dashboard:3000`.

The ingest hostname (e.g. `logs.yourdomain.com`) is served by the Cloudflare Worker, configured separately in [Edge Ingestion Setup](#edge-ingestion-setup).

## Dashboard Authentication (email OTP)

The dashboard uses HMAC-signed session cookies and 6-digit email OTPs — there are no user accounts to manage. Anyone whose address is in `AUTH_ALLOWED_EMAILS` can request a code and sign in. OTP records live in SQLite at `/app/data/auth.db` inside the dashboard container (a Docker volume persists them across restarts).

Set `EMAIL_TRANSPORT` to pick how codes are delivered:

| `EMAIL_TRANSPORT` | When to use | Needs |
|-------------------|-------------|-------|
| `smtp` (default) | Local dev (bundled Inbucket) or any SMTP provider (Resend, Mailgun, SES, Postmark…) | `SMTP_HOST`, `SMTP_PORT` |
| `saasmail` | A simple HTTP email API that accepts a multipart `payload` field | `SAASMAIL_API_KEY`, `SAASMAIL_API_URL` |

For most deployments, `smtp` pointed at your provider is the simplest path.

## Email Delivery

Two things send email: dashboard sign-in OTPs and alert notifications.

- **OTP emails** honor `EMAIL_TRANSPORT` (`smtp` or `saasmail`, above).
- **Alert emails** are delivered via the HTTP email API (`SAASMAIL_API_KEY` / `SAASMAIL_API_URL`). The endpoint receives a `POST {SAASMAIL_API_URL}/api/send` with a multipart `payload` field containing `{to, fromAddress, subject, bodyText, bodyHtml}` and a `Bearer` token. Point `SAASMAIL_API_URL` at any service that speaks this shape.

## Create an API Key

API keys live in ClickHouse and gate ingestion. Create one directly:

```bash
docker exec -it log-cannon-clickhouse-1 clickhouse-client -q \
  "INSERT INTO logs.api_keys (api_key, name) VALUES ('$(openssl rand -hex 32)', 'my-app')"
```

Then mirror it into the Worker's KV namespace so the edge can authenticate it (see [Edge Ingestion Setup](#edge-ingestion-setup)). New keys are also manageable from the **API Keys** page in the dashboard.

## Per-Service Retention

Each API key has a `retention_days` setting (`0` = keep forever, the default). Set it inline on the **API Keys** page, or via SQL. The `retention-worker` trims logs older than the configured window once per `RETENTION_INTERVAL_HOURS` (default 24h), per source:

```bash
# Keep only the last 14 days of logs for 'my-app'
docker exec -it log-cannon-clickhouse-1 clickhouse-client -q \
  "ALTER TABLE logs.api_keys UPDATE retention_days = 14 WHERE name = 'my-app'"
```

## Discovery Mode (migration from Seq)

If you're migrating from Seq and don't have your existing API keys handy, enable **Discovery Mode** to auto-provision unknown keys instead of rejecting them:

```bash
DISCOVERY_MODE=true   # in .env
```

When enabled, unknown keys are accepted immediately and registered as sources named `discovered-{key-prefix}` (first 8 chars), which then appear in the dashboard for you to rename. Typical workflow:

1. Set `DISCOVERY_MODE=true` and point your apps at Log Cannon (same endpoint format as Seq).
2. Apps send logs → keys auto-provision.
3. Review and rename discovered sources in the dashboard.
4. Set `DISCOVERY_MODE=false` when migration is complete.

## Custom Dashboards

Build dashboards from configurable widgets backed by raw SQL against ClickHouse.

### Widget Types

| Type | Description | Key config |
|------|-------------|------------|
| `stat` | Single KPI metric | `valueField`, `format` (number/percent/duration), `trend` |
| `line_chart` | Time-series line chart | `xField`, `yField` (string or array), `colors` |
| `bar_chart` | Categorical bar chart | `xField`, `yField` (string or array), `colors` |
| `pie_chart` / `doughnut_chart` | Proportional chart | `xField` (label), `yField` (value), `colors` |
| `scatter_chart` | Correlation scatter | `xField` (numeric), `yField` (numeric), `colors` |
| `table` | Sortable data table | `columns`, `sortBy` |

### Example

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
      "visualization": { "xField": "time", "yField": "count" }
    }
  ]
}
```

## Alerts

Define alerts in `alert-worker/alerts.json`. Each alert runs a SQL query on an interval and emails recipients when its condition is met:

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

## API & MCP

The dashboard exposes a REST API and an MCP server, both authenticated with the same API keys (scoped `read` or `write`).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/*` | Various | REST API (queries, keys, dashboards, alerts, backups…) |
| `/api/mcp` | POST | MCP server (Model Context Protocol) |

Ingestion endpoints (`/ingest/clef`, `/api/events/raw`, `/ingest/webhook`, `/ingest/otlp/*`, `/v1/logs`, `/v1/traces`) are served by the edge Worker — see [Ingest Routes](#ingest-routes).

### MCP Server

Log Cannon exposes its API as an [MCP](https://modelcontextprotocol.io) server at `/api/mcp`, so AI assistants and other MCP clients can use its tools directly.

**Claude Code** (`~/.claude.json`) / **Cursor** (`.cursor/mcp.json`):

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

Tools are scoped to your key's permissions. See the **MCP** page in the dashboard for interactive setup.

## Edge Ingestion Setup

Your log clients talk to a single Cloudflare Worker that validates API keys (against KV) and enqueues raw payloads onto a Cloudflare Queue. The Go `queue-consumer` (already running in Compose) drains the queue into ClickHouse.

### 1. Create Cloudflare resources

```bash
npx wrangler queues create log-cannon-ingest   # note the Queue ID
npx wrangler kv namespace create API_KEYS       # note the namespace ID
```

### 2. Populate API keys in KV

The KV key is the raw API key string; the value is JSON with the source name:

```bash
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

### 3. Configure the Worker

Update `workers/packages/ingest/wrangler.toml` with your KV namespace ID and routes:

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

### 4. Deploy the Worker

```bash
cd workers
pnpm install
cd packages/ingest && pnpm wrangler deploy
```

### 5. Configure the queue consumer

Add the Cloudflare credentials to your `.env` (the consumer needs an API token with **Queues: Read**):

```env
CF_ACCOUNT_ID=your-cloudflare-account-id
CF_QUEUE_ID=your-queue-id-from-step-1
CF_API_TOKEN=your-api-token-with-queue-permissions
```

Then restart it:

```bash
docker compose up -d queue-consumer
```

### 6. Verify

```bash
curl -X POST https://logs.yourdomain.com/ingest/clef \
  -H "X-Seq-ApiKey: your-api-key" \
  -d '{"@t":"2026-01-01T00:00:00Z","@mt":"Hello from edge","@l":"Information"}'

docker compose logs -f queue-consumer
```

### Ingest Routes

A single Worker handles every ingestion format via path-based routing:

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

## Backup & Restore

Automated ClickHouse backups run twice daily with offsite sync to Cloudflare R2.

### Setup R2

1. Cloudflare dashboard → **R2 Object Storage → Create bucket** (e.g. `log-cannon-backups`).
2. **Manage R2 API Tokens → Create API Token** with **Object Read & Write** on the bucket.
3. Note the **Account ID**, **Access Key ID**, and **Secret Access Key**, and add them to `.env`:

```env
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET=log-cannon-backups
```

Then rebuild: `docker compose build backup && docker compose up -d backup`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_CRON` | `0 3,15 * * *` | Cron schedule (3 AM and 3 PM) |
| `BACKUP_RETAIN_LOCAL` | `7` | Local backups to keep |
| `BACKUP_RETAIN_OFFSITE` | `14` | R2 backups to keep |
| `R2_BUCKET` | `log-cannon-backups` | R2 bucket name |

### Operations

```bash
docker compose exec backup /scripts/backup.sh                       # manual backup
docker compose exec backup /scripts/restore.sh                      # list available backups
docker compose exec backup /scripts/restore.sh logs-2026-03-15-030000   # restore (auto-downloads from R2 if not local)
```

**Disaster recovery (fresh server):** set up Docker Compose, clone the repo, configure `.env` with your R2 credentials, `docker compose up -d`, wait for ClickHouse to go healthy, then run the restore command above. Backup status is also visible in the dashboard under **System → Backups**.

## Environment Variables

See [`.env.example`](.env.example) for the full annotated list. The essentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_SECRET` | Yes | 32+ random bytes signing session cookies (`openssl rand -hex 32`) |
| `AUTH_ALLOWED_EMAILS` | Yes | Comma-separated allowlist of sign-in emails |
| `CLOUDFLARE_TUNNEL_TOKEN` | Yes | Cloudflare Tunnel token (dashboard access) |
| `EMAIL_FROM` | Yes | From-address for OTP emails |
| `EMAIL_TRANSPORT` | No | `smtp` (default) or `saasmail` |
| `SMTP_HOST` / `SMTP_PORT` | If `smtp` | SMTP server (defaults target the bundled Inbucket) |
| `SAASMAIL_API_KEY` / `SAASMAIL_API_URL` | If `saasmail`, or for alerts | HTTP email API credentials/endpoint |
| `ALERT_FROM_EMAIL` | No | Sender for alert emails |
| `RETENTION_INTERVAL_HOURS` | No | How often retention trims expired logs (default `24`) |
| `DISCOVERY_MODE` | No | `true` to auto-provision unknown API keys (migration) |
| `CF_ACCOUNT_ID` / `CF_QUEUE_ID` / `CF_API_TOKEN` | Yes | Queue consumer → Cloudflare Queue access |
| `R2_*` | No | Offsite backup credentials (see Backup & Restore) |
| `COMPOSE_PROFILES` | No | `dev` locally to start the Inbucket mailbox |

## Project Structure

```
log-cannon/
├── workers/            # Cloudflare Workers (TypeScript) — edge ingestion
│   └── packages/ingest/    # Unified ingest worker (CLEF, webhook, OTel)
├── queue-consumer/     # Go service: pulls CF Queue → parses → ClickHouse
├── dashboard/          # Next.js web UI, REST API, MCP server (reads ClickHouse)
├── alert-worker/       # Go service: threshold alerting
├── retention-worker/   # Go service: per-source retention trimming
├── clickhouse/         # Database image + numbered schema init (clickhouse/init)
├── backup/             # Backup/restore scripts with R2 offsite sync
└── docker-compose.yml
```

## Tech Stack

- **Edge ingestion**: Cloudflare Workers (TypeScript) + Queues + KV
- **Queue consumer / alert / retention workers**: Go 1.22+
- **Dashboard / API / MCP**: Next.js, React 18, Tailwind CSS
- **Storage**: ClickHouse
- **Infrastructure**: Docker Compose, Cloudflare Tunnel, Cloudflare R2 (backups)

## Contributing

Issues and pull requests are welcome. The repo is a monorepo of independent services — see [`AGENTS.md`](AGENTS.md) for a developer-oriented map of how the pieces fit together, how to build and run each one, and the conventions to follow.

## License

MIT — see [`LICENSE.md`](LICENSE.md).
