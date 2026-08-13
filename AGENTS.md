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
- **Dashboard:** `cd dashboard && npm install && npm run dev` (`build`, `start`, `lint`, `typecheck` also available). Next.js, React 19, Tailwind 3.
- **Worker:** `cd workers && pnpm install`, then `cd packages/ingest && pnpm wrangler deploy` (or `pnpm wrangler dev`). pnpm workspace; the Worker is **not** part of Compose. Tests: `pnpm --filter @log-cannon/ingest test` (vitest on workerd).

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR:

| Job | Gates |
|-----|-------|
| `go` (×3: queue-consumer, alert-worker, retention-worker) | `gofmt -l` must be empty, then vet, build, test |
| `workers` | `tsc --noEmit`, vitest, and `wrangler deploy --env production --dry-run` |
| `dashboard` | `tsc --noEmit`, `eslint . --quiet`, `next build` |
| `docker` (×2: dashboard, queue-consumer) | image builds; the dashboard image must also load better-sqlite3 in the runner stage |

Test coverage is uneven — `queue-consumer` and the ingest Worker have suites, the other two Go services have none, and the dashboard has no unit tests (`next build` + `tsc` are the gate). Tracked in [#60](https://github.com/RedLegDev/log-cannon/issues/60); treat green CI on `alert-worker`, `retention-worker` and the dashboard as "it compiles", not "it works".

**Why the `docker` job exists separately.** `better-sqlite3` is a native module compiled against the image's Node ABI, and `dashboard/Dockerfile` hand-copies its files into the runner stage. A dependency bump can typecheck and `next build` clean and still fail to produce a working image — v13 did exactly that by dropping `bindings`/`file-uri-to-path`. If you touch `better-sqlite3` or the Node base image, the app-level jobs passing means nothing; watch the `docker` job.

**The dashboard image installs from the lockfile.** `dashboard/Dockerfile` copies `package.json` + `package-lock.json` and runs `npm ci` (no `--omit=dev` — `next build` needs devDeps). A green `docker` job means the image matches the lockfile, including the native `better-sqlite3` ABI compiled in the runner stage.

**Lint is a ratchet, not a clean slate.** `eslint . --quiet` gates the dashboard job. Don't add rule overrides to silence new findings — fix the code. Client data loading goes through `dashboard/src/hooks/useFetch.ts` (setState in the fetch callbacks, not the effect body) so `react-hooks/set-state-in-effect` stays satisfied.

**Node base image.** The dashboard stays on `node:24-alpine` (LTS) by choice; the move to node:26 is verified and deferred until Node 26 reaches LTS in Oct 2026 ([#61](https://github.com/RedLegDev/log-cannon/issues/61)). Don't take a dependabot Node bump without reading that issue.

**pnpm in CI:** `defaults.run.working-directory` does not apply to `uses:` steps, so `pnpm/action-setup` needs `package_json_file: workers/package.json` to find the pinned `packageManager`.

## Conventions & gotchas

- **No standalone ingest service.** A Go `ingest-api/` existed historically but was retired — ingestion is Worker → Queue → consumer only. Don't reintroduce a direct HTTP ingest path without discussion.
- **ClickHouse schema** lives in `clickhouse/init/NNN_*.sql`, applied in numeric order. These run **only on a fresh data dir** — an existing volume will not pick up a new migration file automatically; apply schema changes to a running instance by hand (e.g. via `clickhouse-client`).
- **API keys live in D1, behind the ingest Worker.** The Worker owns the only write path (`/v1/keys`, admin scope); the dashboard is a client of it. Never add a second key store — that dual-homing was the bug this replaced. See `docs/superpowers/specs/2026-08-06-api-key-registry-d1-design.md`.
- **Worker rollback caveat.** If the ingest Worker is rolled back to the pre-migration KV build while the dashboard keeps running the new D1-backed code, D1 rows are not lost — but KV is now frozen, and the Worker is the thing validating keys at the edge. A key disabled or deleted in the dashboard **stays valid at the edge indefinitely** in that state, not for the ~5 minute auth-cache window that normally bounds staleness. After any Worker rollback, mirror pending revocations into the KV namespace by hand until the Worker is rolled forward again.
- **`lookupKey` couples dashboard/MCP auth to Worker availability.** `dashboard/src/lib/key-registry.ts`'s `lookupKey` fetches the full key list from the ingest Worker (cached 30s). If the Worker is unreachable, dashboard REST API and MCP authentication fail too — worth checking first when diagnosing "why can't I auth into the dashboard" reports.
- **Email has two transports.** Dashboard OTP supports `smtp` (nodemailer; default, targets Inbucket locally) and `saasmail` (HTTP `POST {SAASMAIL_API_URL}/api/send`, multipart `payload` field, Bearer auth). The alert worker only sends via the `saasmail`-style HTTP API. `EMAIL_TRANSPORT` selects the OTP path.
- **Build stamp.** The dashboard image bakes a build time into `dashboard/src/generated/version.json` (read by `src/lib/build-info.ts`); the runtime `BUILD_TIME` env var overrides it. Don't expect git commit/branch metadata — that stamping was removed.
- **Config via env only.** No secrets in the repo. Defaults in `docker-compose.yml` and `.env.example` use placeholder/example values; real values come from `.env`.
- **CLEF is the contract.** Seq/Serilog compatibility is a core feature — preserve the `/ingest/clef` and `/api/events/raw` endpoint shapes and CLEF field semantics.
