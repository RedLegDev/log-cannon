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
│  Ingest Worker ───────────► CF Queue      │   validates API key (D1),
│  (CLEF · webhook · OTel)    (buffers ≤4d)  │   enqueues the raw payload
└──────────────────────────┬────────────────┘
                           │ pull
                           ▼
┌─ Your server (Docker Compose) ────────────┐
│  Queue Consumer (Go) ──► ClickHouse        │   parses CLEF/webhook/OTel,
│  Dashboard (Next.js) ──► reads ClickHouse  │   batch-inserts
│  Alert Worker (Go) ────► email             │
│  Retention Worker (Go) ─► trims ClickHouse │
│  Supabase Pull (Go) ───► ClickHouse        │   optional: Supabase
│  Backup ───────────────► Cloudflare R2     │
│                                            │
│  Access via Cloudflare Tunnel (TLS/DDoS)   │
└────────────────────────────────────────────┘
```

The Worker is deliberately thin — it only authenticates the request against its D1 key registry and pushes the raw body to the queue. All parsing happens in the Go queue consumer on your server, using the same code paths regardless of source format. When your server goes offline the Worker keeps accepting logs and the queue holds them (up to 4 days) until the consumer drains the backlog.

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

The Worker is what your log clients actually talk to. See [Edge Ingestion Setup](#edge-ingestion-setup) below for the full walkthrough (create a Queue + D1 database, bootstrap an admin key, deploy).

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

API keys live in D1, behind the ingest Worker — there is no separate store to keep in sync. Create and manage them from the **API Keys** page in the dashboard (it talks to the Worker's admin API), or directly against the Worker:

```bash
curl -X POST https://logs.yourdomain.com/v1/keys \
  -H "X-Api-Key: your-admin-scoped-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","scopes":"ingest"}'
```

See [Edge Ingestion Setup](#edge-ingestion-setup) for bootstrapping the first admin key.

**Changes:** `GET`/`POST /api/v1/keys` (the dashboard's REST API) now return `created_at` as an ISO 8601 timestamp, not the previous ClickHouse-formatted string. The field name is unchanged.

## Per-Service Retention

Each API key has a `retention_days` setting (`0` = keep forever, the default). `logs.api_keys` is no longer read by anything — do not hand-edit it; the dashboard's periodic projection sync will overwrite or `ALTER ... DELETE` anything there that doesn't match the D1 registry. Set retention through one of the two paths that actually work:

- The **API Keys** page in the dashboard, or
- `PATCH /v1/keys/{keyId}` against the ingest Worker with an admin-scoped key:

```bash
curl -X PATCH https://logs.yourdomain.com/v1/keys/your-key-id \
  -H "X-Api-Key: your-admin-scoped-key" \
  -H "Content-Type: application/json" \
  -d '{"retentionDays": 14}'
```

Either path updates D1 immediately; the dashboard projects that change into ClickHouse `logs.key_policies` after every mutation and on a periodic sync (see `dashboard/src/instrumentation.ts`). The `retention-worker` trims logs older than the configured window once per `RETENTION_INTERVAL_HOURS` (default 24h), per source — so a retention change can take up to a day to actually trim anything, even though it reaches D1 and the projection right away. "I set 7 days and nothing happened yet" is expected until the worker's next pass.

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

> **`count()` over `logs.events` can over-count.** Ingest is at-least-once and
> nothing dedupes: `id` is generated at insert, so if the consumer inserts a
> batch and then fails to acknowledge it, the queue redelivers and those events
> are inserted a second time as distinct rows. The consumer retries the ack
> inside the message lease to make this rare (`queue-consumer/main.go`), but it
> is not impossible. Prefer a threshold with margin over one that trips on an
> exact count, and treat a single doubled interval as suspect before treating it
> as real.

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

Your log clients talk to a single Cloudflare Worker that validates API keys (against D1) and enqueues raw payloads onto a Cloudflare Queue. The Go `queue-consumer` (already running in Compose) drains the queue into ClickHouse.

### 1. Create Cloudflare resources

```bash
npx wrangler queues create log-cannon-ingest   # note the Queue ID
```

### 2. Create the key registry

```bash
npx wrangler d1 create log-cannon-keys        # note the database ID
npx wrangler d1 migrations apply log-cannon-keys --remote
```

Keys are managed in the dashboard UI, or directly through the Worker's admin
API. Bootstrap the first admin key by hand:

```bash
npx wrangler d1 execute log-cannon-keys --remote --command \
  "INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
   VALUES ('your-admin-key', lower(hex(randomblob(16))), 'admin', 1, 'admin', 0, datetime('now'))"
```

Set that key as `LOG_CANNON_ADMIN_KEY` in your `.env` so the dashboard can
manage keys. There is no second store to keep in sync.

### 3. Configure the Worker

Update `workers/packages/ingest/wrangler.toml` with your D1 database ID and routes:

```toml
[[d1_databases]]
binding = "KEYS_DB"
database_name = "log-cannon-keys"
database_id = "YOUR_D1_DATABASE_ID"    # ← replace
migrations_dir = "migrations"

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

### Ingest Latency

Senders bound their outbound request — Serilog's Seq sink and most hand-rolled
clients both do — so a stalled ingest call is aborted client-side. Nothing is
written and the response is never read, which leaves the sender's timeout as
the only evidence the request happened. Two things make it visible from the
ingest side instead.

**Workers Logs.** `[observability]` in `wrangler.toml` is on, with
`invocation_logs`, so every request records wall time, CPU time and outcome.
That is where ingest p50/p95/p99 comes from, and it retains the warning below.
Note it does *not* set `logs.destinations`: pointing a Logpush destination at a
Log Cannon ingest route is right for other Workers, but on this one it loops —
the destination delivers to `/ingest/webhook` on the very Worker whose
invocations it is reporting.

**Slow-request events.** Any ingest request that spends `SLOW_REQUEST_MS` or
more in the Worker is written as a `Warning` to `SLOW_REQUEST_SOURCE`, through
the same queue as every other event, so it lands in `logs.events` alongside
everything else. The emission happens after the response, and is throttled per
isolate so a degraded queue is not answered with more traffic.

| Worker var | Default | Description |
|------------|---------|-------------|
| `SLOW_REQUEST_MS` | `1000` | Report at or above this many milliseconds. `0` disables. |
| `SLOW_REQUEST_SOURCE` | `log-cannon-ingest` | Source the events are written to. Empty leaves Workers Logs as the only channel. |
| `QUEUE_ACK_DEADLINE_MS` | `0` | Stop waiting for the queue ack after this long and finish the send in the background. `0` waits in full. |

The Worker stamps this `source` itself and needs no key for it, but retention is
projected from the key registry by name (see [Per-Service Retention](#per-service-retention)),
so a source with no key of the same name is kept forever. Volume is low — only
requests over the threshold, throttled per isolate — but if you want these
trimmed, register a key named `SLOW_REQUEST_SOURCE` and set its `retentionDays`.

Each event carries the breakdown, which is the point — a 5-second request is a
different incident depending on where the time went:

| Property | Meaning |
|----------|---------|
| `TotalMs` | Time inside the Worker |
| `AuthMs` | D1 key lookup |
| `ReadMs` | Reading (and gzip-decoding) the request body |
| `EnqueueMs` | Wait on the `INGEST_QUEUE` send — the full send, or the deadline if one was hit |
| `EnqueueHandedOff` | Present, and `true`, only when the send outlived `QUEUE_ACK_DEADLINE_MS` and finished in the background |
| `KeyCacheHit` | Whether the key was already in this isolate's cache |
| `Route` / `Format` / `Status` | Which endpoint, which parser, what was returned |
| `IngestSource` | The `source` the request was writing to |
| `BodyBytes` / `QueueMessages` | Payload size and how many queue messages it became |
| `Colo` / `RayId` | Cloudflare edge location and Ray ID, for correlating with Workers Logs |

A cold isolate pays for a D1 round trip on every request, so `KeyCacheHit:
false` with a large `AuthMs` is the expected shape for a source that sends a
handful of events a day — worth ruling in before looking further.

`TotalMs` starts when the Worker is invoked, so connection setup, TLS and
isolate cold start sit outside it. **A sender that saw 5 s against a small
`TotalMs` is a result, not a broken measurement**: it places the stall before
the Worker rather than inside it. Cloudflare freezes `Date.now()` between I/O
operations, so these spans measure I/O; a CPU-bound stall shows up in Workers
Logs' `cpuTime` instead.

To alert on degradation while it is happening, add an alert over these events:

```json
{
  "id": "ingest-latency",
  "name": "Ingest Latency",
  "query": "SELECT count() as cnt FROM logs.events WHERE source = 'log-cannon-ingest' AND timestamp > now() - INTERVAL 5 MINUTE",
  "condition": "cnt > 0",
  "interval_seconds": 60,
  "cooldown_seconds": 900
}
```

Because the events are throttled per isolate, treat `cnt` as "how many isolates
saw this", not as a count of slow requests. For the latter, read Workers Logs.

#### Bounding the queue wait

The `INGEST_QUEUE` send is a durable-acknowledgement round trip, so whatever
Cloudflare Queues takes to acknowledge is time the sender spends waiting for its
response. On a healthy, idle queue that tail has been measured in seconds, with
a worst case over a minute — and because senders bound their own request
(Serilog's Seq sink and most hand-rolled clients at around 5 s), they abort and
lose the batch while the platform itself is fine.

`QUEUE_ACK_DEADLINE_MS` bounds the *caller's* wait, not the send. Set it, and a
send that has not acked by the deadline is moved to the background: the response
goes out immediately and the send runs to completion behind it. Chunked bodies
are safe — the deadline covers the whole enqueue, so the batches that had not
gone out yet still go out.

It ships at `0`, meaning off, and should be switched on deliberately. A handoff
means the Worker has answered `201` before the queue has durably accepted the
payload, so a send that then fails is a loss the client already believes
succeeded. That case is reported, never silent: an `ingest-enqueue-failed-after-response`
line in Workers Logs and a matching CLEF `Error` on `SLOW_REQUEST_SOURCE`,
carrying the route, the source, and how many messages were lost. Alert on it
separately from the latency alert above:

```json
{
  "id": "ingest-enqueue-loss",
  "name": "Ingest Enqueue Loss",
  "query": "SELECT count() as cnt FROM logs.events WHERE source = 'log-cannon-ingest' AND level = 'Error' AND timestamp > now() - INTERVAL 5 MINUTE",
  "condition": "cnt > 0",
  "interval_seconds": 60,
  "cooldown_seconds": 900
}
```

**Choosing a value.** Size it from your own measured `EnqueueMs`, not from a
round number. Two bounds fix it: it must sit far enough below your senders'
own fetch timeout that the response still reaches them, and far enough above
your queue's ordinary ack that sends which would have completed in time are
untouched. Query the slow-request events for the distribution — `SELECT
quantile(0.9)(JSONExtractFloat(properties, 'EnqueueMs')) FROM logs.events WHERE
source = 'log-cannon-ingest'` — and pick a deadline above the bulk of it. A
deadline below your p90 hands off routinely and converts an ordinary slow send
into an un-acked one, which is the trade running backwards.

### Go service logs

`queue-consumer`, `alert-worker`, and `retention-worker` still write to stdout
(`docker compose logs`), and can also ship CLEF into Log Cannon the same way
any other client does: `POST {LOG_CANNON_INGEST_URL}/ingest/clef` with
`X-Api-Key`. Shipping is best-effort and never blocks the service's real work;
if the URL or key is unset, the service starts normally with shipping off.

Mint **one ingest-scoped key per service**. The key's registry name becomes
`logs.events.source` — use these names so operators know what to query and
what to attach retention to:

| Service | Env var for the key | Key name / `source` |
|---------|---------------------|---------------------|
| queue-consumer | `LOG_CANNON_QUEUE_CONSUMER_API_KEY` | `log-cannon-queue-consumer` |
| alert-worker | `LOG_CANNON_ALERT_WORKER_API_KEY` | `log-cannon-alert-worker` |
| retention-worker | `LOG_CANNON_RETENTION_WORKER_API_KEY` | `log-cannon-retention-worker` |
| supabase-pull | `LOG_CANNON_SUPABASE_PULL_API_KEY` | `supabase-pull` |

All four share `LOG_CANNON_INGEST_URL` (same as the dashboard). Compose maps
each `*_API_KEY` into the container as `LOG_CANNON_API_KEY`.

**Feedback loop.** The consumer is the process that inserts whatever it ships.
Logging every poll cycle about inserting N events would enqueue more events to
insert. So the consumer does **not** tee stdout: it only ships a CLEF event when
a poll is slow or failed — `Warning` when total time crosses `POLL_SLOW_MS`
(default `1000`), `Error` on pull/flush failure (with the same phase breakdown)
— and at most once per `POLL_TELEMETRY_MIN_INTERVAL_MS` (default `10000`).
Stdout still prints every pull/insert with durations. Alert and retention tee
every `log.Printf` — their volume is low.

A source with no matching key in `logs.key_policies` is kept forever; register
keys with the names above (and set `retentionDays`) if you want these trimmed.

| Consumer var | Default | Description |
|--------------|---------|-------------|
| `POLL_SLOW_MS` | `1000` | Ship a timing event when any phase or the total is at least this many milliseconds. `0` disables CLEF timings (stdout unchanged). |
| `POLL_TELEMETRY_MIN_INTERVAL_MS` | `10000` | Minimum gap between two queue-borne slow-poll events. |
| `ASYNC_ACK_DEPTH` | `0` | Hand the ack to a background worker instead of waiting for it. `0` keeps acking inline. See below. |
| `QUEUE_CONSUMER_WORKERS` | `1` | Independent poll loops. `1` is the single serial loop. Clamped to the ClickHouse pool (10). See below. |

### Taking the ack off the critical path

A poll is `pull → parse → insert → ack`, in series, and the next pull cannot
start until the ack lands. The ack is about half of it — ~1.2s of a ~2.5s cycle
at rest, and ~2.4s of ~5s while Cloudflare Queues is degraded — against an
insert that costs ~12ms. So consumer throughput tracks Queues latency rather
than the work being done, and *falls* exactly when the queue is filling faster.

`ASYNC_ACK_DEPTH > 0` starts a background ack worker with a queue that deep.
The poll hands off and returns; the ack completes behind it. That is safe
against early redelivery because a message stays leased for
`visibility_timeout_ms` (120s) whether or not its ack has arrived — the lease
bounds it, not the ack.

**It ships at `0`, and that default is the point.** With it on, `poll()` reports
a clean cycle *before* the queue has acknowledged, so a failing ack surfaces
asynchronously — a log line and a CLEF `Error` on the consumer's source —
rather than as the poll's own error. The failure is still loud and still
alertable; it just arrives after the poll said it was fine. That is a real
change to how a duplicate-producing failure is noticed, so turn it on
deliberately.

Two behaviours worth knowing:

- **A full queue acks inline.** If the worker falls behind, the poll acks
  synchronously rather than dropping the job or letting the backlog grow. A
  dropped ack is a guaranteed duplicate, and an unbounded backlog would push the
  ack past the lease and duplicate anyway.
- **The depth is bounded by arithmetic, not taste.** A handed-off job can wait
  behind the whole queue plus one in flight, so it completes at worst
  `(depth+1) x 15s` after a flush that may already have used 60s of the 120s
  lease. Anything deeper starts acking after the lease has expired — by which
  point the message has been redelivered and the batch is inserted twice. The
  consumer clamps `ASYNC_ACK_DEPTH` to what fits (currently **2**) and logs when
  it does.
- **Shutdown drains.** Pending acks finish on their own context, not the
  cancelled one, because the events are already in ClickHouse — an abandoned ack
  is not a lost write but a duplicated one on the next start. The grace is
  derived from the same arithmetic (~50s), and a poll still acking inline
  (synchronously, or because the ack queue was full) can need its own 15s
  before the drain starts. The synchronous ack also uses its own context, so
  SIGTERM does not abandon it either. **`docker-compose.yml`
  sets `stop_grace_period: 75s` for this service**; on Docker's 10s default, SIGKILL
  would land mid-drain and the code's patience would be fiction.

`AckMs` measures the handoff rather than the round trip once this is on, so
`TotalMs` stops including the ack — that is the improvement, but it does change
what the numbers mean. Events carry `AckAsync: true` so the two regimes are
distinguishable in `logs.events`; an event from the default path is
byte-identical to one from before this existed.

### Concurrent poll workers

With the ack moved off the critical path, the pull is the remaining serial
cost. A pull to Cloudflare Queues takes 1–2s at rest, and several times a day
it fails with a 504 after ~15s, which freezes the only loop for that long.

`QUEUE_CONSUMER_WORKERS=N` runs N independent poll loops. Each one does the
same pull → parse → insert → ack-after-flush cycle on its own lease, so
Queues latency is paid in parallel and one stuck pull holds up 1/N of
intake instead of all of it.

- **Ack ordering is unchanged.** Pulls lease disjoint sets of messages for the
  120s visibility window, so each worker keeps the ack-after-flush invariant for
  its own messages. No worker acks anything another worker inserted.
- **Order is not a concern.** Every event carries its own `timestamp`;
  `logs.events` sorts by it.
- **Shared ack worker.** With `ASYNC_ACK_DEPTH` on, all workers hand off to the
  same bounded ack queue, and a full queue still acks inline, so the lease
  arithmetic above holds for any N.
- **The cost to watch is ClickHouse inserts.** N workers make N smaller inserts
  per cycle. `InsertMs` is in the slow-poll events; if it starts rising, stop
  raising N. N is clamped to the ClickHouse connection pool (10) so a flush never
  waits for a connection.
- **Idle cost.** An empty queue gets up to N pulls a second instead of one.
  Pull consumers are limited per queue by message throughput (5,000/s), not by
  the general API request limit.

It ships at `1`: this is the only writer of `logs.events`, and N workers means
N times the ack calls, so N times the exposure to a failed ack duplicating a
batch (#116). Raise it deliberately, and measure with the ingest-lag query in
#111.

Slow-poll properties: `Messages`, `Events`, `PullMs`, `ParseMs`, `InsertMs`,
`AckMs`, `TotalMs`.

## The ingest dead-letter queue

A message the consumer cannot insert is retried, and if it still fails it is
parked on **`log-cannon-ingest-dlq`** rather than deleted. Without that queue,
Cloudflare discards a message once it exhausts `max_retries` — and for a log
platform the discarded payload is exactly the evidence you would want.

Current settings on the `log-cannon-ingest` pull consumer:

| Setting | Value | Why |
|---|---|---|
| `max_retries` | `5` | ~10 minutes at the 120s lease — enough to ride out a ClickHouse restart or a Portainer redeploy without anyone touching the DLQ. |
| `visibility_timeout_ms` | `120000` | The lease. `flushTimeout` (60s) + the ack retry budget (15s) must fit inside it. |
| `batch_size` | `100` | Matches what each pull requests. |
| `dead_letter_queue` | `log-cannon-ingest-dlq` | Where a message goes after `max_retries`. |

The DLQ keeps messages for **14 days** (not the 4-day default), so something
parked on a Friday is still there on Monday.

### When a message lands there

Two shapes, and they want different responses:

- **One message, repeatedly.** Almost certainly a payload the consumer cannot
  insert — a bad timestamp, an oversized row. Since an append failure is
  isolated to its own message, it parks alone and nothing else is affected.
  Inspect it, fix the cause, and decide whether to replay it.
- **Many messages at once.** Not a payload problem — the write path was down
  for longer than the retry budget. Check ClickHouse first, then replay.

### Inspecting it

The DLQ has an `http_pull` consumer attached purely so it can be read; nothing
polls it. Pull without acking to look without consuming — the messages return
after the visibility timeout:

```bash
ACCT=<account id>; DLQ=<dlq queue id>
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/queues/$DLQ/messages/pull" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"visibility_timeout_ms": 30000, "batch_size": 10}' | jq '.result.messages[].body'
```

Each message body is the envelope the ingest Worker enqueues — `source`,
`format`, `contentType`, and the raw request `body` base64-encoded — so the
original payload is recoverable.

One wrinkle: the pull API sometimes returns that envelope **double-encoded**, as
a JSON string rather than an object (`queue-consumer/main.go` unwraps this on
every message). Handle both:

```bash
... | jq -r '.result.messages[0].body | if type == "string" then fromjson else . end | .body' | base64 -d
```

That prints the exact bytes the client POSTed — for CLEF, one JSON event per
line.

### Draining it

There is no automatic replay, deliberately — a message is in the DLQ because
inserting it failed, and replaying blindly just fails again. Once the cause is
fixed, replay by POSTing the decoded payload back to the normal ingest endpoint
(`/ingest/clef` with an ingest key), then ack the DLQ copy so it does not linger.

Ack with the `lease_id` from the pull:

```bash
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/queues/$DLQ/messages/ack" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"acks": [{"lease_id": "<lease_id>"}]}'
```

If the messages are not worth replaying, acking them is how you discard them.

## Supabase platform logs

`supabase-pull` pulls a Supabase project's platform logs (Postgres, Auth, Edge
Function console output and Edge Function requests) from the Management API's
unified logs endpoint and writes them straight into `logs.events`. It runs in
Compose next to the other workers and does nothing until a project is enabled.

```bash
SUPABASE_PULL_PROJECTS=abcdefghijklmnopqrst=myapp-supabase,<ref>=<source>
SUPABASE_ACCESS_TOKEN=sbp_...   # personal access token with analytics_logs_read
```

Each row lands with `source = <source>` and these properties, which is what
alerts and queries should filter on:

| Property | Value |
|----------|-------|
| `Source` | the configured source name (`myapp-supabase`) |
| `LogTable` | `postgres_logs`, `auth_logs`, `function_logs` or `function_edge_logs` |
| `ProjectRef` | the Supabase project ref |
| `sb_id` | the Supabase row id — the dedupe key |
| `sb_<attribute>` | every non-empty `log_attributes` key, dots and other non-word characters flattened to `_` (`request.path` → `sb_request_path`) |

`level` maps from `severity_text` (`ERROR` → `Error`, `LOG`/`NOTICE`/`INFO` →
`Information`, `PANIC`/`FATAL` → `Fatal`, and so on); `message` is the
`event_message`.

**How it keeps its place.** There is no state file. On start it takes
`max(timestamp)` per `LogTable` from `logs.events` for rows whose `Source`
*property* matches, which lets it resume from rows another shipper wrote under a
different `source` column. Each run then re-reads from `watermark −
SUPABASE_PULL_OVERLAP` so late-arriving rows are still collected, and skips any
row whose `sb_id` is already stored (rows without one, from an earlier shipper,
are matched on timestamp and message). Stopping it for a while and starting it
again fills the gap without duplicating rows, back as far as
`SUPABASE_PULL_MAX_LOOKBACK`. Keep that within the log retention of your
Supabase plan.

**Catch-up.** A run pages (500 rows, keyset on timestamp and id) until it is
caught up, walking 23-hour windows because the endpoint rejects a longer one,
and stops at `SUPABASE_PULL_MAX_PAGES` per table (default 50) so one huge
backlog cannot hold a run indefinitely. Where it stopped is where the next run
starts.

**Rate limit.** The logs endpoint allows 10 requests per window per project
and answers `429` with `Retry-After` beyond that. Steady state is one request
per table per run (4 a minute per project at the defaults), which fits. A
catch-up that needs more pages waits out `Retry-After` and retries (up to 5
times) instead of failing the table, so a long backlog drains at the API's
pace. Anything else calling the same project's logs endpoint shares that
budget.

**Self-report.** One CLEF event per run under the `supabase-pull` key:
`Inserted`, `Pages`, `MaxReadLagSeconds` (how far behind the present the worst table has been read — near zero when caught up), `Behind`, and a `Tables` array
with per-table rows, pages, read lag and watermark age (the newest stored row; absent for a table with none). Any failed table (API error,
refused token, ClickHouse error) raises the event to `Error`, so
`source = 'supabase-pull' AND level = 'Error'` is the alert condition for the
puller itself. Stdout carries one line per table per run.

**Retention.** Register an ingest key named after each `<source>` (and one named
`supabase-pull`) and set `retentionDays`. The puller doesn't use those keys to
write; retention is looked up by source name, and a source with no key is kept
forever.

**Do not run two shippers for one project.** Anything else that ships the same
project's logs (Log Drains, a cron poller) must be stopped before the project is
added here, or every event arrives twice. Deploy with the project list empty,
stop the other shipper, then enable the project.

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_PULL_PROJECTS` | *(empty)* | `ref=source` pairs, comma-separated. Empty = idle. |
| `SUPABASE_ACCESS_TOKEN` | — | Supabase PAT; required once a project is enabled |
| `SUPABASE_PULL_TABLES` | all four | Comma-separated subset of the tables above |
| `SUPABASE_PULL_INTERVAL` | `1m` | Pause between runs |
| `SUPABASE_PULL_OVERLAP` | `5m` | How far behind the watermark each run re-reads |
| `SUPABASE_PULL_MAX_LOOKBACK` | `72h` | Oldest a run will reach, including after an outage |
| `SUPABASE_PULL_MAX_PAGES` | `50` | Pages per table per run |

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
docker compose exec backup /scripts/restore.sh logs-full-2026-03-15-030000   # restore (auto-downloads from R2 if not local)
```

**Restore replaces, it does not append.** `restore.sh` drops the `logs` database before restoring so a run against a live volume does not duplicate `events`. ClickHouse’s `allow_non_empty_tables` setting is append-only (it inserts into existing tables and can silently double history); the script uses it only when applying an incremental backup’s delta onto a freshly restored base. Do not run restore against production unless you intend a full replace.

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
| `CF_ACCOUNT_ID` / `CF_QUEUE_ID` / `CF_API_TOKEN` | Yes | Queue consumer → Cloudflare Queue access |
| `LOG_CANNON_INGEST_URL` / `LOG_CANNON_ADMIN_KEY` | Yes | Ingest Worker URL and admin-scoped key so the dashboard can manage the D1 key registry |
| `LOG_CANNON_QUEUE_CONSUMER_API_KEY` / `LOG_CANNON_ALERT_WORKER_API_KEY` / `LOG_CANNON_RETENTION_WORKER_API_KEY` | No | Per-service ingest keys so the Go workers ship CLEF (see [Go service logs](#go-service-logs)); key names should be `log-cannon-queue-consumer`, `log-cannon-alert-worker`, `log-cannon-retention-worker` |
| `SUPABASE_PULL_PROJECTS` / `SUPABASE_ACCESS_TOKEN` | No | Supabase projects to pull platform logs from, and a PAT with `analytics_logs_read` (see [Supabase platform logs](#supabase-platform-logs)) |
| `R2_*` | No | Offsite backup credentials (see Backup & Restore) |
| `COMPOSE_PROFILES` | No | `dev` locally to start the Inbucket mailbox |

## Project Structure

```
log-cannon/
├── workers/            # Cloudflare Workers (TypeScript) — edge ingestion
│   └── packages/ingest/    # Unified ingest worker (CLEF, webhook, OTel)
├── go/ship/            # Shared Go CLEF shipper (replace-path dep of the Go services)
├── queue-consumer/     # Go service: pulls CF Queue → parses → ClickHouse
├── dashboard/          # Next.js web UI, REST API, MCP server (reads ClickHouse)
├── alert-worker/       # Go service: threshold alerting
├── retention-worker/   # Go service: per-source retention trimming
├── supabase-pull/      # Go service: Supabase platform logs → ClickHouse (optional)
├── clickhouse/         # Database image + numbered schema init (clickhouse/init)
├── backup/             # Backup/restore scripts with R2 offsite sync
└── docker-compose.yml
```

## Tech Stack

- **Edge ingestion**: Cloudflare Workers (TypeScript) + Queues + D1
- **Queue consumer / alert / retention workers**: Go 1.22+
- **Dashboard / API / MCP**: Next.js, React 18, Tailwind CSS
- **Storage**: ClickHouse
- **Infrastructure**: Docker Compose, Cloudflare Tunnel, Cloudflare R2 (backups)

## Contributing

Issues and pull requests are welcome. The repo is a monorepo of independent services — see [`AGENTS.md`](AGENTS.md) for a developer-oriented map of how the pieces fit together, how to build and run each one, and the conventions to follow.

## License

MIT — see [`LICENSE.md`](LICENSE.md).
