# scripts/

## seed-d1-keys.mjs

One-time (idempotent) migration tool that builds seed SQL for the D1
`api_keys` table from the two legacy API key registries: Cloudflare KV
(authoritative for what actually authenticates ingest traffic today) and
ClickHouse `logs.api_keys` (source of `scopes` and `retention_days`, and of
any UI-created key that never made it into KV).

KV wins on existence and name. ClickHouse only overrides the name when the
KV entry carries an auto-generated `discovered-<prefix>` label and
ClickHouse has a real human-assigned name for the same key. ClickHouse-only
keys (rows with no matching KV entry) are carried forward as new, enabled
D1 rows — those keys never worked before, since KV is what gated ingest.

### Usage

```bash
node scripts/seed-d1-keys.mjs --kv scripts/.seed-kv.json --clickhouse scripts/.seed-ch.json > scripts/.seed.sql
```

Re-running with an unchanged input set produces the same SQL — every row
is an `INSERT ... ON CONFLICT(api_key) DO UPDATE`.

### Inputs

- `--kv`: JSON array of `{ key, value }`, one entry per `wrangler kv key
  list` / `wrangler kv key get` pair against the `API_KEYS` namespace.
  `value` is the KV JSON payload (string or parsed object) with `name` and
  `enabled` fields.
- `--clickhouse`: JSON array of rows from:

  ```sql
  SELECT key_id, name, api_key, enabled, scopes, retention_days,
         toString(created_at) AS created_at
  FROM logs.api_keys
  ```

### Live-key values never touch this repo

`scripts/.seed-*.json` and `scripts/.seed*.sql` contain real API key
values and are gitignored (see `/scripts/.seed-*.json` and
`/scripts/.seed-*.sql` in the root `.gitignore`) — this repo is public.
Never commit them; only `seed-d1-keys.mjs` and this README are tracked.
