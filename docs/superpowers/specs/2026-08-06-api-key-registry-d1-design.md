# API Key Registry → D1

**Date:** 2026-08-06
**Status:** Approved, pending implementation plan

## Problem

API keys are dual-homed, and the two homes drift.

| | Ingest Worker | Dashboard UI / MCP |
|---|---|---|
| Store | Cloudflare KV `API_KEYS` | ClickHouse `logs.api_keys` |
| Written by | manual `wrangler kv key put` | `createAPIKey()` → `INSERT` |

No sync path exists anywhere in the repo. `README.md` §"Populate API keys in KV" documents a manual `wrangler` loop as the intended workflow, and `AGENTS.md:47` states the constraint outright: *"API keys are dual-homed… Keep both in sync."* Enforcement is human discipline.

Consequence: **a key created in the dashboard UI has never been able to authenticate an ingest request.** Production runs `DISCOVERY_MODE=false`, so unknown keys hard-reject rather than self-register. The failure is silent from the UI's perspective — the key is created successfully, listed as enabled, and simply does not work.

Observed on 2026-08-06: 26 of 29 ClickHouse keys were present in KV (manually synced at some point). Three were missing — the three most recently UI-created keys. One was actively blocking a client integration.

### Second, latent defect

`retention-worker/main.go:110` matches `api_keys.name` → `events.source` by exact string equality. But `source` is not always the key's name:

- `queue-consumer/otlp.go:41-43` and `:78-80` — an OTLP `service.name` resource attribute overrides it.
- `queue-consumer/webhook.go:261` — a webhook preset `SourceField` overrides it.
- Discovery-mode keys carry a generated `discovered-<prefix>` name in KV, which may differ from the human name in ClickHouse.

So per-service retention silently never fires for any OTLP-overridden source, nor for any key whose two stores disagree on name. At time of writing this exempts several hundred thousand events across multiple sources from their configured retention window.

## Design

### 1. D1 as sole writable source of truth

A D1 `api_keys` table replaces both stores:

| column | notes |
|---|---|
| `api_key` | primary key; the raw key string |
| `key_id` | UUID, stable external identifier |
| `name` | default source label |
| `enabled` | integer boolean |
| `scopes` | comma-separated: `ingest,read,write,admin` |
| `retention_days` | 0 = keep forever |
| `created_at` | |

The ingest Worker binds D1 and validates against it, **retaining the existing in-isolate `Map` cache** (`KEY_CACHE`, 5-minute TTL). The hot-path cost is therefore unchanged from KV today: a cache hit does no I/O, and a miss does one indexed point lookup. KV is retired.

The existing cache trade-off is unchanged and still accepted: a disabled key is served from warm isolates for up to 5 minutes; compromise response remains rotate-and-redeploy, not instant revoke.

### 2. The Worker owns writes; the dashboard is a client

The Worker gains an admin API at `/v1/keys` — `GET`, `POST`, `PATCH`, `DELETE` — authenticated by an `admin`-scoped key. The dashboard's key-management routes call it instead of issuing ClickHouse DDL.

This is the load-bearing property of the design: **the path that creates a key is the same path that authenticates it.** The original bug becomes structurally impossible rather than merely documented against.

Self-hosting impact: none. The Worker already holds the binding, so no new Cloudflare credential enters the Docker stack. The dashboard needs one log-cannon admin key, which it requires in order to manage keys at all.

### 3. The projection is pulled by the dashboard, not pushed by the Worker

The Worker cannot reach ClickHouse — it sits behind a Cloudflare Tunnel — so a push-based projection is not available.

Instead the dashboard, which already holds the admin key and already has a ClickHouse connection, refreshes a read-only `logs.key_policies` table after every mutation and on a periodic timer. `retention-worker` changes one table name and is otherwise untouched.

The failure mode is deliberately asymmetric: a stale projection delays a retention change. It cannot break ingest authentication, because ingest never reads the projection.

### 4. Retention keys on source, not key name

`key_policies` is keyed by observed `source`, not by key name, and the dashboard offers retention configuration against sources actually present in `logs.events`. Carrying the current name-keyed scheme forward would faithfully reproduce a rule that already does not fire.

### Data flow

```
UI ──POST /v1/keys (admin key)──▶ Worker ──▶ D1  (source of truth)
                                    │
  producers ──X-Seq-ApiKey──────────┘  (in-isolate cache, 5 min)

Dashboard ──pull──▶ Worker /v1/keys
    └──▶ logs.key_policies (read-only projection, keyed by source)
              ▲
              └── retention-worker
```

## Migration

KV — not ClickHouse — is the authoritative seed, because KV is what actually authenticates traffic today.

1. Create the D1 database and schema.
2. Seed from KV (30 entries), left-joined against ClickHouse `logs.api_keys` for `scopes` and `retention_days`.
3. Reconcile divergences:
   - **ClickHouse-only keys** — never worked for ingest. Carry forward as enabled.
   - **KV-only keys** — currently working. Must carry forward or traffic breaks.
   - **Test artifacts** — several `discovered-*` and probe entries in KV to be dropped after confirming zero recent traffic.
   - **Duplicate names** — multiple keys legitimately share a source name (several sources have 2–3 keys). Preserved; not deduplicated.
4. Rename `discovered-<prefix>` entries to their intended human names. **This changes `source` for future events and splits history at the cutover timestamp.** Either accept the split, or backfill existing rows — decide per source before cutover.
5. Deploy the Worker against D1. `DISCOVERY_MODE` stays `false` in production.
6. Switch dashboard key management to the Worker admin API.
7. Verify ingest across a sample of live producers, then drop ClickHouse `logs.api_keys` and delete the KV namespace.

Steps 5–7 are separately reversible; the D1 schema and seed (1–4) are additive and can land ahead of any cutover.

## Testing

- **Worker unit** — validation against D1 (hit, miss, disabled), cache hit/miss behaviour, admin API authz including the negative case that an `ingest`-scoped key cannot call `/v1/keys`.
- **Migration** — seed script is idempotent; re-running produces no duplicates. Reconciliation asserted against a fixture of the real divergence shape.
- **End-to-end** — create a key through the dashboard UI, then immediately authenticate an ingest request with it. This is the regression test for the original bug and must exist.
- **Retention** — a policy on an OTLP-overridden source now matches, which is the fix for the latent defect.

## Out of scope

- Instant key revocation (the 5-minute cache window is accepted).
- Rotating or re-issuing any existing key.
- `queue-consumer` changes; it never reads the key store.
- Changing how `source` is derived. Override precedence stays as-is; only retention's *matching* is corrected.

## Resolved decisions

- **Rename `discovered-*`; backfill was cancelled.** Only one such source is live: `discovered-DDXKgcKt` (PEPOCS), ~70,892 events, last seen 2026-08-06. It is renamed to `PEPOCS` in D1. The ClickHouse backfill (rewriting its existing rows to the new name) was cancelled by the repo owner, and could not have been done with `ALTER ... UPDATE` regardless — `source` is part of the `logs.events` sort key, and ClickHouse mutations cannot rewrite sort-key columns. As a result, those ~70,892 historical rows keep the `discovered-DDXKgcKt` name and are not matched by the `PEPOCS` retention policy in `logs.key_policies`. This fails safe: the unmatched rows are simply never trimmed under the new policy (over-retention), not deleted early. The other eight `discovered-*` sources are dormant (last activity April/June 2026) and are left as they are.
- **A key-store failure returns 500, not 403.** `authenticate()` returns 403 only for the two known auth failures (`Invalid API key`, `API key is disabled`); anything else — D1 outage, timeout, schema fault — is a 500. Seq/Serilog sinks treat 4xx as non-retryable and drop the batch, so classifying an outage as 403 would convert a transient D1 problem into permanent log loss across every client at once. This corrects behaviour inherited from the KV implementation, where the simpler read path made the risk tolerable.

## Open questions

- Should the admin API be rate-limited, given it is reachable at the edge?
