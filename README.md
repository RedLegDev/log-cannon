# Log Cannon

An open-source alternative to [Seq](https://datalust.co/seq) for log aggregation and analysis, running entirely on Cloudflare. Drop-in compatible with `Serilog.Sinks.Seq`: point your existing sink at Log Cannon and keep shipping CLEF.

- **Seq-compatible ingestion**: works with existing Serilog/CLEF configurations, plus webhook and OpenTelemetry (logs + traces) endpoints.
- **Basin storage**: every event is parsed at the edge and written to Cloudflare Basin, an Iceberg table on R2, queried with Basin SQL.
- **Query API and MCP**: SQL and search over HTTP, and an MCP server for AI assistants.
- **Threshold alerts**: SQL conditions evaluated every minute, delivered by email or webhook.
- **Supabase platform logs**: optional pull of Postgres, Auth and Edge Function logs from the Supabase Management API.

## Architecture

One Cloudflare Worker (`workers/packages/ingest`) is the whole service.

```
Serilog / OTel / webhooks ──► Worker ── auth (D1 key registry)
                                   └── parse CLEF / OTLP / webhook
                                       └─► LOGS stream (Pipelines) ──► sink ──► logs.events (Iceberg on R2)
                                       └─► on failure: BASIN_SPILL (R2) ──► replayed by cron

agents / scripts ──► /api/v1/query, /api/v1/logs, /api/mcp ──► Basin SQL
cron * * * * *   ──► due alerts (D1) ──► Basin SQL ──► email / webhook
                 ──► Supabase Management API ──► LOGS stream
                 ──► spill replay
cron 17 20 * * * ──► Basin retention (day partitions; off by default)
```

The write happens in `waitUntil`, after the response, so a slow or failing stream never slows or fails an ingest request. A send that fails is retried, then spilled to R2 and replayed by the cron (see [Durability](#durability)). Basin flushes on a 60 s roll, so data is queryable 1–2 minutes after it is accepted.

> **Remnants of v1.** The ClickHouse stack (`clickhouse/`, `dashboard/`, `retention-worker/`, `backup/`, `go/ship/`, `docker-compose.yml`) holds the pre-cutover history read-only. It is kept until the ~2026-11-22 shutdown, then removed. Nothing writes to it.

## Setup

### Prerequisites

- A Cloudflare account with a zone for the ingest hostname, and Workers, D1, R2 and Basin enabled
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and [pnpm](https://pnpm.io/)

### 1. Provision Basin

```bash
CLOUDFLARE_ACCOUNT_ID=... BASIN_CATALOG_TOKEN=... \
  workers/packages/ingest/basin/provision.sh
```

This creates the `log-cannon-events` bucket with Basin Catalog (compaction at 128 MB, snapshot expiry at 7 days keeping 5), the `log_events_v1` stream from `basin/log_events_v1.schema.json`, the `log_events_v1_catalog` sink writing `logs.events` on a 60 s roll, and the pipeline joining them. `BASIN_CATALOG_TOKEN` needs R2 Admin Read & Write. The stream schema can't be changed after creation: a breaking change means a new `log_events_v2` stream and table.

Create the spill bucket too:

```bash
npx wrangler r2 bucket create log-cannon-basin-spill
```

### 2. Create the key registry

```bash
npx wrangler d1 create log-cannon-keys        # note the database ID
npx wrangler d1 migrations apply log-cannon-keys --remote
```

The migrations create the key table, the alert tables and the Supabase pull state. Bootstrap the first admin key by hand:

```bash
npx wrangler d1 execute log-cannon-keys --remote --command \
  "INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
   VALUES ('your-admin-key', lower(hex(randomblob(16))), 'admin', 1, 'admin', 0, datetime('now'))"
```

### 3. Configure the Worker

`workers/packages/ingest/wrangler.toml` keeps a generic top level and a `[env.production]` block for the Red Leg Dev deployment; copy that block's shape for your own. You need:

- the D1 binding `KEYS_DB` with your database ID,
- a `[[pipelines]]` binding `LOGS` with your stream ID,
- R2 bindings `BASIN_SPILL` (the spill bucket) and, only for retention in `delete` mode, `BASIN_EVENTS` (the catalog bucket),
- `BASIN_WRITE = "true"`. **Without it, and without the `LOGS` binding, ingest answers 2xx and stores nothing.**
- `BASIN_SQL_ACCOUNT` and `BASIN_SQL_BUCKET` for the read API,
- routes for every ingest and read path on your hostname (see [Routes](#routes)), each with a trailing `*` so query strings still match.

Secrets, set with `wrangler secret put`:

| Secret | Needed for |
|--------|------------|
| `BASIN_SQL_TOKEN` | The read API, MCP and alerts (Basin SQL read) |
| `SAASMAIL_API_KEY` | Alert email |
| `SUPABASE_ACCESS_TOKEN` | The Supabase pull |
| `BASIN_CATALOG_TOKEN` | Retention in `delete` mode only (R2 Data Catalog write) |

`keep_vars = true` keeps vars set on the deployed Worker that the file doesn't declare (production uses it for `SUPABASE_PULL_PROJECTS`, which names projects). Vars the file does declare still win on every deploy.

### 4. Deploy

```bash
cd workers && pnpm install
cd packages/ingest && pnpm wrangler deploy --env production
```

### 5. Point a client at it

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

Verify with a direct send, then find it once Basin flushes:

```bash
curl -X POST https://logs.yourdomain.com/ingest/clef \
  -H "X-Seq-ApiKey: your-api-key" \
  -d '{"@t":"2026-01-01T00:00:00Z","@mt":"Hello from edge","@l":"Information"}'

curl "https://logs.yourdomain.com/api/v1/logs?source=your-key-name&hours=1" -H "X-Api-Key: your-read-key"
```

## Routes

| Path | Method | Purpose |
|------|--------|---------|
| `/ingest/clef` | POST | CLEF (NDJSON), the primary Seq/Serilog endpoint |
| `/api/events/raw` | POST | CLEF, legacy Seq path |
| `/ingest/webhook` | POST | Webhook JSON; `?preset=cloudflare` for Logpush |
| `/ingest/otlp/logs`, `/v1/logs` | POST | OTel logs, protobuf or JSON |
| `/ingest/otlp/traces`, `/v1/traces` | POST | OTel traces, protobuf or JSON |
| `/api/v1/logs` | GET | Search |
| `/api/v1/query` | POST | Basin SQL, `{"sql": "SELECT ..."}` |
| `/api/mcp` | POST | MCP server |
| `/api/v1/alerts`, `/api/v1/alert-destinations` | various | Alert and destination management |
| `/v1/keys` | various | Key registry admin API (admin scope) |
| `/health` | GET | `{"status":"ok"}` |

Every read path also answers under `/v2` (`/v2/api/v1/query`), an alias for callers that moved before cutover. Unprefixed `/api/v1/logs` rows carry `timestamp` beside `ts` for v1 callers.

A body over 32 MB is a `413`. Large CLEF and OTLP bodies are split into chunks of at most 90 KB at line or resource boundaries and parsed a chunk at a time; a single CLEF line or OTLP resource entry over 90 KB is a `413` the sender has to fix.

## API keys

Keys live in D1, behind the Worker. Scopes are `ingest`, `read`, `write` and `admin`. Manage them through the admin API with an admin-scoped key:

```bash
curl -X POST https://logs.yourdomain.com/v1/keys \
  -H "X-Api-Key: your-admin-scoped-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","scopes":"ingest"}'
```

`GET /v1/keys` lists them, and `PATCH` / `DELETE /v1/keys/{keyId}` change or remove one. A key's name is the `source` its events are stored under; its id is stored as `key_id`.

## Querying

Basin SQL is Apache DataFusion, not ClickHouse. The full reference (table schema, query patterns, limits, the alert and destination API) is served by the Worker: MCP `get_docs`, or read `workers/packages/ingest/src/docs.ts`. The essentials:

| ClickHouse | Basin SQL |
|---|---|
| `countIf(x)` | `count(*) FILTER (WHERE x)` |
| `toStartOfMinute(ts)` | `date_trunc('minute', ts)` |
| `JSONExtractString(properties, 'k')` | `json_get_str(properties, 'k')` |
| `uniqExact(x)` | `count(DISTINCT x)` |
| `now() - INTERVAL 1 HOUR` | `now() - INTERVAL '1 hour'` |

- `ts` is the event time and `received_at` when the Worker accepted it; Basin adds `__ingest_ts`, which is the day partition. Filter on `ts` to bound a scan.
- A query with no `LIMIT` gets `LIMIT 10000`. SELECT and WITH only: Basin SQL is read-only.
- **Filters on `message`, `message_template`, `properties` and `exception` must be `LIKE '%…%'`.** Basin's writers record a string column's manifest upper bound from one row group instead of the whole file, and the reader prunes on it, so `=`, `IN`, prefix `LIKE` and range filters on those columns miss rows (#187). `basin/check-manifest-bounds.py` finds bad files and `basin/repair-manifest-bounds.py` rebuilds their manifest entries.
- Delivery is at-least-once. A retried send or a spill replay can store a row twice with the same `id`, visible as `count(*) > count(DISTINCT id)`. Alert thresholds should have margin.

### MCP server

`/api/mcp` serves `search_logs`, `execute_query`, `get_overview`, `get_firing_alerts`, `create_alert`, `create_log` and `get_docs`, scoped to the key's permissions. `create_log` writes through the same path as `/ingest/clef`.

**Claude Code** (`~/.claude.json`) / **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "log-cannon": {
      "type": "http",
      "url": "https://logs.yourdomain.com/api/mcp",
      "headers": { "X-Api-Key": "your-api-key" }
    }
  }
}
```

## Alerts

Alerts and destinations live in D1 and are managed through `/api/v1/alerts` and `/api/v1/alert-destinations` (or MCP `create_alert`). An alert is a Basin SQL SELECT returning one row of numbers, plus a condition over that row's columns (`cnt > 50`, `errors >= 10 && total > 100`; `&&` binds before `||`, no parentheses). Destinations are email (via `SAASMAIL_API_URL` and `ALERT_FROM_EMAIL`) or webhook.

The cron evaluates the due alerts once a minute. Every `now()` in an alert query is pinned `ALERT_LAG_SECONDS` (default 180) behind evaluation time, because Basin trails ingest by 1–2 minutes and a window ending at the true now would fire zero-count alerts on data that hasn't landed. `POST /api/v1/alerts/:id/test` runs a query exactly as the evaluator would; add `"deliver": true` to also send through the alert's destinations without starting its cooldown.

| Var | Default | Description |
|-----|---------|-------------|
| `ALERTS_MODE` | `off` | `off`, `shadow` (evaluate and record, send nothing) or `live` |
| `ALERT_LAG_SECONDS` | `180` | How far every alert's `now()` is pinned back |
| `ALERTS_SOURCE` | `log-cannon-alerts` | Source for the evaluator's own events (errors, sends) |
| `SAASMAIL_API_URL` / `ALERT_FROM_EMAIL` | — | Email delivery; the key is the `SAASMAIL_API_KEY` secret |

Email goes out as `POST {SAASMAIL_API_URL}/api/send` with a multipart `payload` field holding `{to, fromAddress, subject, bodyText, bodyHtml}` and a Bearer token.

## Durability

A failed `LOGS` send is retried from one budget per copy (0.5 s, 2 s, 5 s; no retry starts past 12 s; each attempt is cut at 5 s). When the retries run out, the failing batch, the batches behind it and the bodies not yet parsed go, as parsed rows, to one gzipped NDJSON object in `BASIN_SPILL`, keyed `spill/<received_at>/<uuid>.ndjson.gz`. The spill put gets 7 s; a copy still running at 28 s is reported lost. Without a spill bucket, unsent rows are lost and reported.

The cron's spill replay sends objects oldest first (up to 200 per tick, 45 s deadline) and deletes each only once every row went out; a part-sent object is rewritten as its remainder. A tick that did work or saw a backlog writes a `Basin spill replay sent …` summary to `SLOW_REQUEST_SOURCE`, a Warning once the oldest object is past 30 minutes.

Failures are reported on two channels: a `basin-copy-failed` line in Workers Logs and a CLEF event on `SLOW_REQUEST_SOURCE` (`Basin copy failed …`), a Warning when every unsent row was spilled and an Error when any was lost. Alert on the Error:

```sql
SELECT count(*) AS cnt FROM logs.events
WHERE source = 'log-cannon-ingest' AND level = 'Error' AND message LIKE '%Basin copy failed%'
  AND ts > now() - INTERVAL '10 minutes'
```

The failure report's own copy goes straight to the spill when the stream is the problem, so a stream outage is paged when the replay delivers it, not during the outage.

## Ingest latency

Senders bound their outbound request (Serilog's Seq sink and most hand-rolled clients at about 5 s), so a stalled ingest call is aborted client-side and leaves only the sender's timeout as evidence. Two things make it visible from the ingest side.

**Workers Logs.** `[observability]` in `wrangler.toml` is on, with `invocation_logs`, so every request records wall time, CPU time and outcome. That is where ingest p50/p95/p99 comes from. It deliberately does *not* set `logs.destinations`: on this Worker a Logpush destination delivers to `/ingest/webhook` on the Worker whose invocations it is reporting, which loops.

**Slow-request events.** An ingest request that spends `SLOW_REQUEST_MS` or more in the Worker is logged as `slow-ingest-request` and written as a CLEF `Warning` to `SLOW_REQUEST_SOURCE`, after the response and throttled per isolate.

| Var | Default | Description |
|-----|---------|-------------|
| `SLOW_REQUEST_MS` | `1000` | Report at or above this many milliseconds. `0` disables. |
| `SLOW_REQUEST_SOURCE` | `log-cannon-ingest` | Source the Worker's own events go to. Empty leaves Workers Logs as the only channel. |

| Property | Meaning |
|----------|---------|
| `TotalMs` | Time inside the Worker |
| `AuthMs` | D1 key lookup |
| `ReadMs` | Reading (and gzip-decoding) the request body |
| `KeyCacheHit` | Whether the key was already in this isolate's cache |
| `Route` / `Format` / `Status` | Endpoint, parser, response status |
| `IngestSource` / `BodyBytes` | The key's source and the payload size |
| `Colo` / `RayId` | Edge location and Ray ID, for correlating with Workers Logs |
| `EnqueueMs` / `QueueMessages` | Always `0` since the queue was retired; kept so the event's template and `event_type` don't change |

The Basin write runs after the response, so it is not part of `TotalMs`. A cold isolate pays for a D1 round trip, so `KeyCacheHit: false` with a large `AuthMs` is the expected shape for a source that sends a few events a day. `TotalMs` starts when the Worker is invoked, so connection setup, TLS and cold start sit outside it: a sender that saw 5 s against a small `TotalMs` places the stall before the Worker. Cloudflare freezes `Date.now()` between I/O, so these spans measure I/O; a CPU-bound stall shows in Workers Logs' `cpuTime`. Because the events are throttled per isolate, count them as "isolates that saw this", not slow requests.

## Supabase platform logs

The cron pulls a Supabase project's platform logs (`postgres_logs`, `auth_logs`, `function_logs`, `function_edge_logs`) from the Management API's unified logs endpoint and sends them to the `LOGS` stream as `format = 'supabase'`, `key_id = 'supabase-pull'`, with `id` set to the Supabase row id.

| Var | Default | Description |
|-----|---------|-------------|
| `SUPABASE_PULL_PROJECTS` | *(empty)* | `ref=source` pairs, comma-separated. Empty is a no-op. Needs `BASIN_WRITE` on and the `SUPABASE_ACCESS_TOKEN` secret (a PAT with `analytics_logs_read`). |
| `SUPABASE_PULL_TABLES` | all four | Comma-separated subset |

Rows carry `Source`, `LogTable`, `ProjectRef`, `sb_id` and `sb_<attribute>` properties; `level` maps from `severity_text` and `message` is `event_message`. State is in D1 (`supabase_pull_cursor`, `supabase_pull_seen`), never read back from Basin, and the cursor moves only after Basin accepted a page. Each tick reads at most 10 pages per table; a `429` ends that table for the tick without moving its cursor. `function_edge_logs` rows drop most headers, IP-shaped keys and deployment bookkeeping to stay under Basin's 2,000-byte `json_get` limit. The per-run summary goes to source `supabase-pull`, at Error level when a table failed.

Don't run a second shipper (Log Drains, another poller) against a project that is enabled here: every event arrives twice, and the endpoint's limit of 10 requests per window per project is shared.

## Retention

`src/basin-retention.ts` runs on its own daily cron (20:17 UTC). Basin SQL is read-only and `logs.events` is partitioned by ingest day only, so it can't delete per key: it commits an Iceberg `delete` snapshot that drops every data file whose ingest day ended before `now − longest window`, where the windows come from each key's `retention_days` (`0` and unknown keys get `BASIN_RETENTION_DEFAULT_DAYS`, default 30). The catalog's snapshot expiry then removes the files.

`BASIN_RETENTION_MODE` is `off` (default), `dry-run` (plan and report, change nothing) or `delete` (also needs the `BASIN_CATALOG_TOKEN` secret and the `BASIN_EVENTS` binding). Each run writes one `Basin retention …` summary to `log-cannon-ingest`.

Set a key's window with the admin API:

```bash
curl -X PATCH https://logs.yourdomain.com/v1/keys/your-key-id \
  -H "X-Api-Key: your-admin-scoped-key" \
  -H "Content-Type: application/json" \
  -d '{"retentionDays": 14}'
```

## Project structure

```
log-cannon/
├── workers/packages/ingest/   # The service: ingest, Basin write, read API, MCP, alerts, Supabase pull, retention
│   ├── src/                   #   Worker source (parse/, alerts/, supabase/)
│   ├── migrations/            #   D1 migrations
│   ├── basin/                 #   Stream schema, provisioning, manifest-bound tools
│   └── scripts/               #   One-off operator scripts
├── docs/                      # Design notes and plans (docs/v2/PLAN.md is the migration record)
└── clickhouse/, dashboard/, retention-worker/, backup/, go/ship/, docker-compose.yml
                               # v1 ClickHouse stack, kept read-only until the ~2026-11-22 shutdown, then removed
```

## Tech stack

- **Service**: Cloudflare Workers (TypeScript), D1, R2
- **Storage and query**: Cloudflare Basin (Pipelines into Iceberg on R2, Basin SQL)
- **Tests**: vitest on workerd (`@cloudflare/vitest-plugin`)

## Contributing

Issues and pull requests are welcome. See [`AGENTS.md`](AGENTS.md) for a developer-oriented map of the code, how to build and test it, and the conventions to follow.

## License

MIT — see [`LICENSE.md`](LICENSE.md).
