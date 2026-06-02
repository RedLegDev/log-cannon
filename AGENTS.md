# AGENTS.md

Developer and agent guide to the Log Cannon codebase. For product/usage docs see [`README.md`](README.md).

## What this is

A self-hosted, Seq-compatible log platform. Log clients ship CLEF (or webhook/OTel) to a Cloudflare Worker; the Worker enqueues raw payloads; a Go consumer drains the queue into ClickHouse; a Next.js dashboard reads ClickHouse and exposes a REST API + MCP server. Separate Go workers handle alerting and retention.

## Repository layout

This is a monorepo of independent services, each built and deployed on its own.

| Path | Language | Role |
|------|----------|------|
| `workers/packages/ingest/` | TypeScript (Cloudflare Workers) | Thin edge ingest: validate API key against KV, push raw body + metadata to the CF Queue. No parsing here. |
| `queue-consumer/` | Go | Pulls the CF Queue, parses CLEF/webhook/OTel, batch-inserts into ClickHouse. The only writer of `logs.events`. |
| `dashboard/` | Next.js / TypeScript | Web UI, REST API (`/api/v1/*`), and MCP server (`/api/mcp`). Reads ClickHouse; does **not** ingest logs. Owns OTP auth. |
| `alert-worker/` | Go | Runs `alerts.json` queries on intervals, emails on threshold breach. |
| `retention-worker/` | Go | Trims `logs.events` per source based on each key's `retention_days`. |
| `clickhouse/` | Dockerfile + SQL | ClickHouse image and numbered schema init (`clickhouse/init/NNN_*.sql`). |
| `backup/` | Shell | Twice-daily backup + restore with Cloudflare R2 offsite sync. |
| `docker-compose.yml` | — | Runs everything except the Worker (which deploys to Cloudflare). |

## Data flow

```
client ──CLEF/webhook/OTel──► Worker ──raw──► CF Queue ──pull──► queue-consumer ──► ClickHouse
                                                                                       ▲
                                              dashboard / alert-worker / retention ────┘ (read/trim)
```

The Worker is intentionally dumb — it never parses payloads. All format handling (`clef.go`, `webhook.go`, `otlp.go` in `queue-consumer/`) lives server-side so ingest formats can change without redeploying the edge.

## Build & run

- **Everything (server side):** `docker compose up -d`. Add `COMPOSE_PROFILES=dev` for the bundled Inbucket mailbox.
- **Go services:** each has its own `go.mod`. From the service dir: `go build ./...`, `go vet ./...`, `go run .`.
- **Dashboard:** `cd dashboard && npm install && npm run dev` (`build`, `start`, `lint` also available). Next.js, React 18, Tailwind.
- **Worker:** `cd workers && pnpm install`, then `cd packages/ingest && pnpm wrangler deploy` (or `pnpm wrangler dev`). pnpm workspace; the Worker is **not** part of Compose.

There is currently no automated test suite; `.github/` holds only Dependabot config.

## Conventions & gotchas

- **No standalone ingest service.** A Go `ingest-api/` existed historically but was retired — ingestion is Worker → Queue → consumer only. Don't reintroduce a direct HTTP ingest path without discussion.
- **ClickHouse schema** lives in `clickhouse/init/NNN_*.sql`, applied in numeric order. These run **only on a fresh data dir** — an existing volume will not pick up a new migration file automatically; apply schema changes to a running instance by hand (e.g. via `clickhouse-client`).
- **API keys are dual-homed.** They live in ClickHouse (`logs.api_keys`, source of truth for the dashboard/retention) and must be mirrored into the Worker's KV namespace for the edge to authenticate them. Keep both in sync.
- **Email has two transports.** Dashboard OTP supports `smtp` (nodemailer; default, targets Inbucket locally) and `saasmail` (HTTP `POST {SAASMAIL_API_URL}/api/send`, multipart `payload` field, Bearer auth). The alert worker only sends via the `saasmail`-style HTTP API. `EMAIL_TRANSPORT` selects the OTP path.
- **Build stamp.** The dashboard image bakes a build time into `dashboard/src/generated/version.json` (read by `src/lib/build-info.ts`); the runtime `BUILD_TIME` env var overrides it. Don't expect git commit/branch metadata — that stamping was removed.
- **Config via env only.** No secrets in the repo. Defaults in `docker-compose.yml` and `.env.example` use placeholder/example values; real values come from `.env`.
- **CLEF is the contract.** Seq/Serilog compatibility is a core feature — preserve the `/ingest/clef` and `/api/events/raw` endpoint shapes and CLEF field semantics.
