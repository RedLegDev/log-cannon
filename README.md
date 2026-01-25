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
├── ingest-api/       # Go HTTP server for CLEF log ingestion
├── dashboard/        # Next.js web UI for log exploration
├── alert-worker/     # Go service for threshold-based alerting
├── clickhouse/       # Database schema initialization
└── docker-compose.yml
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Resend API key for alert emails |
| `CLOUDFLARE_TUNNEL_TOKEN` | Yes | Cloudflare tunnel token |
| `ALERT_FROM_EMAIL` | No | Sender email for alerts |
| `DISCOVERY_MODE` | No | Set to `true` to auto-provision unknown API keys (for migration) |

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

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ingest/clef` | POST | Primary CLEF ingestion endpoint |
| `/api/events/raw?clef` | POST | Legacy Seq-compatible endpoint |
| `/health` | GET | Health check |

## Tech Stack

- **Ingest API**: Go 1.21+
- **Dashboard**: Next.js 14, React 18, Tailwind CSS
- **Alert Worker**: Go 1.21+
- **Database**: ClickHouse
- **Infrastructure**: Docker Compose, Cloudflare Tunnels

## License

MIT
