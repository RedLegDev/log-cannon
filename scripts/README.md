# scripts/

## seed-d1-keys.mjs

One-time (idempotent) migration tool used to seed the D1 `api_keys`
table from the two legacy registries: Cloudflare KV (what authenticated
ingest at the time of the cutover) and ClickHouse `logs.api_keys`
(source of `scopes` and `retention_days`, and of any UI-created key that
never made it into KV).

The live store is D1. Do not write keys to KV — the ingest Worker no
longer binds or reads `API_KEYS`. Keep this script only in case a
self-hoster is mid-migration and still has the two old stores.

KV won on existence and name. ClickHouse only overrode the name when the
KV entry carried an auto-generated `discovered-<prefix>` label and
ClickHouse had a real human-assigned name for the same key. ClickHouse-only
keys (rows with no matching KV entry) were carried forward as new, enabled
D1 rows — those keys never worked before, since KV is what gated ingest.

### Usage

```bash
node scripts/seed-d1-keys.mjs --kv scripts/.seed-kv.json --clickhouse scripts/.seed-ch.json > scripts/.seed.sql
```

Re-running with an unchanged input set produces the same SQL — every row
is an `INSERT ... ON CONFLICT(api_key) DO UPDATE`.

### Inputs

- `--kv`: JSON array of `{ key, value }`, one entry per `wrangler kv key
  list` / `wrangler kv key get` pair against the (now-unbound) `API_KEYS`
  namespace. `value` is the KV JSON payload (string or parsed object)
  with `name` and `enabled` fields.
- `--clickhouse`: JSON array of rows from:

  ```sql
  SELECT key_id, name, api_key, enabled, scopes, retention_days,
         toString(created_at) AS created_at
  FROM logs.api_keys
  ```

### Live-key values never touch this repo

`scripts/.seed-*.json` and `scripts/.seed*.sql` contain real API key
values and are gitignored (see `/scripts/.seed*` in the root `.gitignore`)
— this repo is public. Never commit them; only `seed-d1-keys.mjs` and
this README are tracked.
