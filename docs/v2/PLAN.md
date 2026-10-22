# Log Cannon v2: Cloudflare-native on Basin

**Status:** in progress on branch `v2`
**Goal:** keep what's actually used (ingest, the query API, MCP, alerts) and run all of it
on Cloudflare. Remove the self-hosted stack (ClickHouse, the queue consumer, the alert and
retention workers, backups, the Next.js dashboard) and the Cloudflare Queue that feeds it.

## Why

- The self-hosted host is a single point of failure for every client's logs and for the
  alerts that watch them. When the uplink drops, Log Cannon goes silent and the alerting
  goes down with it (#152).
- The Queue is a recurring cost billed per message three times over (write, read, delete),
  and it exists only to buffer for a consumer that ClickHouse needs. Basin Pipelines
  ingest is free, and processing/delivery has a 50 GB/month free allowance.
- In practice Log Cannon is read through `/api/v1/query`, `/api/v1/logs` and MCP. The UI,
  live tail and dashboards aren't used.

## MVP scope

| Keep (same URLs, same API keys) | Drop | Defer |
|---|---|---|
| Ingest: `/ingest/clef`, `/api/events/raw`, `/v1/logs`, `/v1/traces`, `/ingest/otlp/*`, `/ingest/webhook`, `/health` | Dashboard UI, OTP login, live tail | Per-key retention (Iceberg row deletes; tracked separately) |
| Key admin API `/v1/keys` (D1, unchanged) | Dashboards, endpoints, saved queries | Tenant-scoped query keys (#47/#48) |
| `/api/v1/query` (SQL), `/api/v1/logs` (search) | Backups, system/storage panel | |
| `/api/mcp`: `search_logs`, `execute_query`, `get_overview`, `get_firing_alerts`, `get_docs`, `create_alert`, `create_log` | Queue, DLQ, Go consumer | |
| `/api/v1/alerts`, `/api/v1/alert-destinations`, alert evaluation and delivery | alert-worker, retention-worker, backup, ClickHouse, Compose stack | |
| Supabase platform-log pull | MCP `create_dashboard` | |

## Shape

One Worker (this package, `workers/packages/ingest`, grown into the whole service):

```
producers ──CLEF / OTLP / webhook──► Worker
                                       auth: D1 key registry (unchanged)
                                       parse: TS port of queue-consumer clef/otlp/webhook
                                       └─► env.LOGS.send(rows) ──► stream log_events_v1
                                                                     └─► sink ──► logs.events (Iceberg in R2)
agents / scripts ──► /api/v1/query, /api/v1/logs, /api/mcp ──► Basin SQL (REST)
cron * * * * *   ──► due alerts (D1) ──► Basin SQL ──► email delivery
cron             ──► Supabase Management API ──► same parse/send path
```

### Schema (`basin/log_events_v1.schema.json`)

This is a fresh schema, designed around the queries we actually run. It does not copy the
ClickHouse table.

- `ts` is the event time (CLEF `@t`, OTLP time). `received_at` is when the Worker accepted
  it, so ingest lag is `received_at - ts`. Basin also adds `__ingest_ts`, which it uses as
  the day partition.
- `source` is the resolved source (the key name, or the OTLP `service.name` / webhook
  preset override). `key_id` is the key that actually sent the event. Retention and any
  future tenant scoping key on `key_id`, which fixes #82.
- `format` is `clef | otlp | webhook | api`. `kind` is `log | span`.
- Span fields (`trace_id`, `span_id`, `parent_span_id`, `duration_ms`) are real columns
  instead of entries in `properties`.
- `properties` uses the `json` type. Query it with `json_get_str(properties, 'Key')`.

The stream schema can't be changed after creation. A breaking change means a new
`log_events_v2` stream and table.

### Query dialect

Basin SQL is Apache DataFusion, not ClickHouse. Callers are rewritten once; there is no
translation layer. Common mappings:

| ClickHouse | Basin SQL |
|---|---|
| `countIf(x)` | `count(*) FILTER (WHERE x)` |
| `toStartOfMinute(ts)` | `date_trunc('minute', ts)` |
| `JSONExtractString(properties, 'k')` | `json_get_str(properties, 'k')` |
| `uniqExact(x)` | `count(DISTINCT x)` |
| `now() - INTERVAL 1 HOUR` | `now() - INTERVAL '1 hour'` |

Basin SQL is read-only, which closes #83. Results are capped at 10,000 rows per query.

### Alerts

Alerts and destinations move to D1. A cron trigger runs every minute, evaluates the alerts
that are due against Basin SQL, and keeps the current cooldown and destination semantics.

Sink flush means data is 1–2 minutes behind. Every alert window therefore ends at
`now() - lag`, not `now()`, or "zero events" alerts would fire on data that just hasn't
landed yet. 60-second alerts become effectively 2-minute alerts.

## Migration

No history backfill. Every source has 21–30 day retention, so after 30 days of
dual-writing, Basin holds the whole window.

1. **Provision** (Red Leg account): R2 bucket + Basin Catalog with compaction and snapshot
   expiry, stream `log_events_v1`, sink `log_events_v1_catalog` (namespace `logs`, table
   `events`, 60 s roll), pipeline. Script: `basin/provision.sh`.
2. **Dual-write:** the Worker parses and sends to Basin *in addition to* enqueueing raw
   to the Queue, behind `BASIN_WRITE`. ClickHouse remains the source of truth. A reconcile
   script compares hourly per-source counts across the two stores. This lands on `main`
   with the flag off, then gets flipped.
3. **Query surface** on the Worker under a side-by-side host, plus rewrites of the callers:
   the `log-cannon` skill and `logcannon.py`, Hermes scripts, and per-repo ops skills.
4. **Alerts:** port to D1 with rewritten SQL, then run in shadow next to alert-worker
   until firing matches.
5. **Supabase pull** moves to a Worker cron.
6. **Cutover:** route `/api/v1/*` and `/api/mcp` on `logs.redleg.dev` to the Worker, stop
   enqueueing, then delete the Queue and DLQ, stop the Compose stack, and retire the host
   after the retention horizon.

## Open (verify during step 2)

- `ORDER BY ts DESC LIMIT 100` latency for one source over 7 days, and `message LIKE`
  search cost. The sink partitions by ingest day only.
- Steady-state lag from send to queryable at a 60 s roll.
- Whether the `json` type queries cleanly with `json_get_*`, or should be a `string`.
- Basin SQL spend at alert cadence (10 MB minimum per query).
