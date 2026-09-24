# AGENTS.md

Developer and agent guide to the Log Cannon codebase. For product/usage docs see [`README.md`](README.md).

## What this is

A self-hosted, Seq-compatible log platform. Log clients ship CLEF (or webhook/OTel) to a Cloudflare Worker; the Worker enqueues raw payloads; a Go consumer drains the queue into ClickHouse; a Next.js dashboard reads ClickHouse and exposes a REST API + MCP server. Separate Go workers handle alerting and retention.

## Repository layout

This is a monorepo of independent services, each built and deployed on its own.

| Path | Language | Role |
|------|----------|------|
| `workers/packages/ingest/` | TypeScript (Cloudflare Workers) | Thin edge ingest: validate API key against D1, push raw body + metadata to the CF Queue. No parsing here. |
| `go/ship/` | Go | Shared CLEF HTTPS client used by the three Go services. Replace-path dep; not a runnable service. |
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
| `go` (×4: go/ship, queue-consumer, alert-worker, retention-worker) | `gofmt -l` must be empty, then vet, build, test |
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
- **Worker rollback caveat.** Rolling the Worker back to a pre-D1 (KV) commit leaves D1 intact, but that old build reads KV — which is no longer bound or written. A key disabled or deleted in the dashboard **stays valid at the edge indefinitely** in that state, not for the ~5 minute auth-cache window that normally bounds staleness. Don't roll back past the D1 cutover; if you must, re-bind the old `API_KEYS` KV namespace and mirror pending revocations into it by hand until the Worker is rolled forward again.
- **`lookupKey` couples dashboard/MCP auth to Worker availability.** `dashboard/src/lib/key-registry.ts`'s `lookupKey` fetches the full key list from the ingest Worker (cached 30s). If the Worker is unreachable, dashboard REST API and MCP authentication fail too — worth checking first when diagnosing "why can't I auth into the dashboard" reports.
- **Email has two transports.** Dashboard OTP supports `smtp` (nodemailer; default, targets Inbucket locally) and `saasmail` (HTTP `POST {SAASMAIL_API_URL}/api/send`, multipart `payload` field, Bearer auth). The alert worker only sends via the `saasmail`-style HTTP API. `EMAIL_TRANSPORT` selects the OTP path.
- **Build stamp.** The dashboard image bakes a build time into `dashboard/src/generated/version.json` (read by `src/lib/build-info.ts`); the runtime `BUILD_TIME` env var overrides it. Don't expect git commit/branch metadata — that stamping was removed.
- **Config via env only.** No secrets in the repo. Defaults in `docker-compose.yml` and `.env.example` use placeholder/example values; real values come from `.env`.
- **CLEF is the contract.** Seq/Serilog compatibility is a core feature — preserve the `/ingest/clef` and `/api/events/raw` endpoint shapes and CLEF field semantics.
- **Go services ship CLEF via `go/ship`, never a second ClickHouse write path.** `LOG_CANNON_INGEST_URL` + `LOG_CANNON_API_KEY` enable best-effort POSTs to `/ingest/clef`; absent config leaves shipping off. The consumer must not tee every `log.Printf` into the queue (feedback loop) — it ships only thresholded/throttled slow-or-failed poll timings. See README "Go service logs".
- **The ingest Worker instruments itself, and must not forward its own logs.** `[observability]` is on (invocation logs, `head_sampling_rate = 1`), `src/timing.ts` owns what a slow request is and how it renders, and the router's `reportIfSlow` sends it two ways: a `console.warn` retained by Workers Logs, and a CLEF `Warning` enqueued on `SLOW_REQUEST_SOURCE` in `waitUntil`. Do **not** add `observability.logs.destinations` here — that shape is correct for every other Worker, but on this one the destination delivers to `/ingest/webhook` on the Worker whose invocations it is reporting, and each delivery generates more. The queue-borne event is throttled per isolate on purpose: the failure mode worth protecting is a slow `enqueue` span, and the wrong answer to a struggling queue is more messages. Timing spans measure I/O only (Cloudflare freezes `Date.now()` between I/O) and start at invocation, so cold start and connection setup are outside them.
- **The queue-ack deadline exists because a slow ack is a slow response, and it ships off.** `src/enqueue.ts` can bound how long the caller waits for `INGEST_QUEUE.send` and finish the send in `waitUntil` instead — the fix for the tail #107 measured, where senders that cap their own fetch at 5 s abort and lose the batch against a healthy, idle queue. Every queue write on the request path goes through `enqueue()` in `src/index.ts`, so the deadline, the `enqueue` span and the loss report cannot drift per route, and the handed-off promise is the *whole* enqueue — a chunked body cannot lose its remaining batches mid-sequence. `QUEUE_ACK_DEADLINE_MS` defaults to `0`, which is byte-for-byte the pre-deadline behaviour, and that default is the point: once it is on the Worker can answer `201` before the queue has durably accepted the payload, so a post-handoff failure is a loss the client already believes succeeded. That case reports as `ingest-enqueue-failed-after-response` on both of #107's channels, on its own throttle budget so a burst of `slow-ingest-request` events cannot crowd out the rarer event that marks actual data loss. Don't flip the default without a deliberate decision — pushing to `main` deploys the Worker.
