# API Key Registry on D1 — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ingest Worker and the dashboard UI read and write one registry, so a key created in the UI authenticates ingest immediately.

**Architecture:** A D1 `api_keys` table becomes the sole writable source of truth. The ingest Worker binds D1 and validates against it, keeping its existing in-isolate cache. The Worker exposes an admin API at `/v1/keys`; the dashboard calls that instead of issuing ClickHouse DDL. Cloudflare KV is read out of the auth path.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Wrangler 4, TypeScript 6, Vitest via `@cloudflare/vitest-pool-workers`, Next.js 16 (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-06-api-key-registry-d1-design.md`

## Global Constraints

- Repo `RedLegDev/log-cannon` is **PUBLIC**. Never commit an API key value, the KV namespace id, or the account id outside the existing `[env.production]` block. Seed data files are gitignored.
- Top-level `wrangler.toml` stays placeholder (`yourdomain.com`, `<your-...-id>`). Real production config lives only in the `[env.production]` block.
- Production deploy command is `pnpm --filter @log-cannon/ingest exec wrangler deploy --env production`. The `--env production` flag is load-bearing.
- `DISCOVERY_MODE` stays `"false"` in production throughout.
- The in-isolate key cache TTL stays 5 minutes. Do not add instant revocation.
- Self-hosters must not need a new Cloudflare credential in the Docker stack.
- Ingest is live for multiple paying clients. No task may leave `main` in a state where a currently-working key stops authenticating.

**Placeholders in this plan.** Commands below use `<red-leg-dev-account-id>`, `<kv-namespace-id-from-env-production-block>`, and `<an-existing-working-key>` rather than literals, because this document is committed to a public repo. Resolve them at run time: the account id from `wrangler whoami`, the KV namespace id from the `[[env.production.kv_namespaces]]` block already in `wrangler.toml`, and a working key from the running dashboard's key list. Never paste the resolved values back into a tracked file.

## File Structure

| Path | Responsibility |
|---|---|
| `workers/packages/ingest/migrations/0001_api_keys.sql` | D1 schema (new) |
| `workers/packages/ingest/src/keys.ts` | Key store: validate, list, create, update, delete (new) |
| `workers/packages/ingest/src/admin.ts` | `/v1/keys` request handlers (new) |
| `workers/packages/ingest/src/index.ts` | Env bindings, routing; delegates auth to `keys.ts` (modify) |
| `workers/packages/ingest/test/keys.test.ts` | Key store tests (new) |
| `workers/packages/ingest/test/admin.test.ts` | Admin API tests (new) |
| `workers/packages/ingest/vitest.config.ts` | Workers pool config (new) |
| `scripts/seed-d1-keys.mjs` | Build seed SQL from KV + ClickHouse exports (new) |
| `dashboard/src/lib/key-registry.ts` | HTTP client for the Worker admin API (new) |
| `dashboard/src/app/api/keys/route.ts` | UI key CRUD → registry client (modify) |
| `dashboard/src/lib/api-auth.ts` | Dashboard API key auth → registry client (modify) |

`index.ts` is ~700 lines and already carries ingest, chunking, and enrichment. Key logic moves out rather than growing it further.

---

### Task 1: D1 database and schema

**Files:**
- Create: `workers/packages/ingest/migrations/0001_api_keys.sql`
- Modify: `workers/packages/ingest/wrangler.toml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: D1 binding `KEYS_DB` on `Env`; table `api_keys` with columns `api_key TEXT PRIMARY KEY`, `key_id TEXT NOT NULL UNIQUE`, `name TEXT NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`, `scopes TEXT NOT NULL DEFAULT 'ingest'`, `retention_days INTEGER NOT NULL DEFAULT 0`, `created_at TEXT NOT NULL`.

- [ ] **Step 1: Create the D1 database**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler d1 create log-cannon-keys
```

Expected: prints a `database_id` UUID. Record it — it goes in the `[env.production]` block only.

- [ ] **Step 2: Write the migration**

Create `workers/packages/ingest/migrations/0001_api_keys.sql`:

```sql
-- API key registry. Sole writable source of truth for ingest auth.
-- api_key is the raw key string presented in X-Seq-ApiKey / X-Api-Key.
CREATE TABLE IF NOT EXISTS api_keys (
  api_key        TEXT PRIMARY KEY,
  key_id         TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  scopes         TEXT NOT NULL DEFAULT 'ingest',
  retention_days INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- Admin list views order by recency; ingest never scans, it points at the PK.
CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys(created_at DESC);
```

- [ ] **Step 3: Add the binding to wrangler.toml**

In `workers/packages/ingest/wrangler.toml`, after the existing top-level `[[kv_namespaces]]` block, add the placeholder binding:

```toml
[[d1_databases]]
binding = "KEYS_DB"
database_name = "log-cannon-keys"
# Create with: wrangler d1 create log-cannon-keys — then paste the id here.
database_id = "<your-d1-database-id>"
migrations_dir = "migrations"
```

And in the `[env.production]` section, after the existing `[[env.production.kv_namespaces]]` block:

```toml
[[env.production.d1_databases]]
binding = "KEYS_DB"
database_name = "log-cannon-keys"
database_id = "<paste-the-id-from-step-1>"
migrations_dir = "migrations"
```

- [ ] **Step 4: Gitignore seed artifacts**

Append to `.gitignore`:

```
# Key-registry migration artifacts — these contain LIVE API key values.
# Keep this pattern broad. A narrower `/scripts/.seed-*` form does NOT match
# the generated `scripts/.seed.sql` (no hyphen), which leaves every live key
# untracked but committable in a public repo.
/scripts/.seed*
```

Verify the pattern actually covers what the later steps generate, rather than assuming:

```bash
git check-ignore -v scripts/.seed.sql scripts/.seed-kv.json scripts/.seed-ch.json
```

Expected: a matching rule printed for **every** path. A path with no output is not ignored.

- [ ] **Step 5: Apply the migration to production D1**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler d1 migrations apply log-cannon-keys --env production --remote
```

Expected: `1 migration(s) applied`. The table is empty; nothing reads it yet.

- [ ] **Step 6: Verify the schema**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler d1 execute log-cannon-keys --env production --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'"
```

Expected: one row, `api_keys`.

- [ ] **Step 7: Commit**

```bash
git add workers/packages/ingest/migrations/0001_api_keys.sql workers/packages/ingest/wrangler.toml .gitignore
git commit -m "feat(ingest): add D1 api_keys schema and binding"
```

---

### Task 2: Key store module with D1 validation

**Files:**
- Create: `workers/packages/ingest/src/keys.ts`
- Create: `workers/packages/ingest/test/keys.test.ts`
- Create: `workers/packages/ingest/vitest.config.ts`
- Modify: `workers/packages/ingest/package.json`

**Interfaces:**
- Consumes: `KEYS_DB` D1 binding from Task 1.
- Produces:
  - `interface APIKeyRecord { apiKey: string; keyId: string; name: string; enabled: boolean; scopes: string[]; retentionDays: number; createdAt: string }`
  - `validateKey(apiKey: string, db: D1Database, now?: number): Promise<APIKeyRecord>` — throws `Error` on unknown or disabled.
  - `hasScope(record: APIKeyRecord, required: Scope): boolean`
  - `type Scope = "ingest" | "read" | "write" | "admin"`
  - `__resetKeyCache(): void` — test-only cache reset.

- [ ] **Step 1: Add test tooling**

```bash
cd workers/packages/ingest
pnpm add -D vitest @cloudflare/vitest-pool-workers
```

`@cloudflare/vitest-pool-workers` pins a narrow compatible `vitest` range. If pnpm reports a peer conflict, install the `vitest` version named in its peer warning rather than the latest.

Then add to `workers/packages/ingest/package.json`:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 2: Configure the Workers test pool**

Create `workers/packages/ingest/vitest.config.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// The config is loaded as ESM, where __dirname is not defined.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

Create `workers/packages/ingest/test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.KEYS_DB, env.TEST_MIGRATIONS);
```

Create `workers/packages/ingest/test/env.d.ts`:

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    KEYS_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 3: Write the failing tests**

Create `workers/packages/ingest/test/keys.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { validateKey, hasScope, __resetKeyCache } from "../src/keys";

async function insert(row: {
  apiKey: string;
  name: string;
  enabled?: number;
  scopes?: string;
}) {
  await env.KEYS_DB.prepare(
    `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
     VALUES (?, ?, ?, ?, ?, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(
      row.apiKey,
      `id-${row.apiKey}`,
      row.name,
      row.enabled ?? 1,
      row.scopes ?? "ingest",
    )
    .run();
}

describe("validateKey", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
  });

  it("returns the record for a known enabled key", async () => {
    await insert({ apiKey: "k-good", name: "Readerful" });

    const record = await validateKey("k-good", env.KEYS_DB);

    expect(record.name).toBe("Readerful");
    expect(record.enabled).toBe(true);
    expect(record.scopes).toEqual(["ingest"]);
  });

  it("throws for an unknown key", async () => {
    await expect(validateKey("k-missing", env.KEYS_DB)).rejects.toThrow(
      "Invalid API key",
    );
  });

  it("throws for a disabled key", async () => {
    await insert({ apiKey: "k-off", name: "Old", enabled: 0 });

    await expect(validateKey("k-off", env.KEYS_DB)).rejects.toThrow(
      "API key is disabled",
    );
  });

  it("parses multi-scope keys", async () => {
    await insert({ apiKey: "k-admin", name: "Claude", scopes: "ingest,admin" });

    const record = await validateKey("k-admin", env.KEYS_DB);

    expect(record.scopes).toEqual(["ingest", "admin"]);
  });

  it("serves a second lookup from cache without re-reading D1", async () => {
    await insert({ apiKey: "k-cached", name: "First" });
    await validateKey("k-cached", env.KEYS_DB);

    await env.KEYS_DB.prepare(
      "UPDATE api_keys SET name = 'Second' WHERE api_key = 'k-cached'",
    ).run();
    const record = await validateKey("k-cached", env.KEYS_DB);

    expect(record.name).toBe("First");
  });

  it("re-reads D1 after the cache TTL expires", async () => {
    await insert({ apiKey: "k-ttl", name: "First" });
    const t0 = 1_000_000;
    await validateKey("k-ttl", env.KEYS_DB, t0);

    await env.KEYS_DB.prepare(
      "UPDATE api_keys SET name = 'Second' WHERE api_key = 'k-ttl'",
    ).run();
    const record = await validateKey("k-ttl", env.KEYS_DB, t0 + 5 * 60 * 1000 + 1);

    expect(record.name).toBe("Second");
  });
});

describe("hasScope", () => {
  const base = {
    apiKey: "k",
    keyId: "id",
    name: "n",
    enabled: true,
    retentionDays: 0,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("grants a scope the key holds directly", () => {
    expect(hasScope({ ...base, scopes: ["ingest"] }, "ingest")).toBe(true);
  });

  it("grants lesser scopes to admin via the hierarchy", () => {
    expect(hasScope({ ...base, scopes: ["admin"] }, "read")).toBe(true);
  });

  it("denies a greater scope to an ingest-only key", () => {
    expect(hasScope({ ...base, scopes: ["ingest"] }, "admin")).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd workers/packages/ingest && pnpm test`
Expected: FAIL — `Failed to resolve import "../src/keys"`.

- [ ] **Step 5: Implement the key store**

Create `workers/packages/ingest/src/keys.ts`:

```ts
// API key registry backed by D1. This is the sole source of truth for ingest
// authentication — see docs/superpowers/specs/2026-08-06-api-key-registry-d1-design.md.

export type Scope = "ingest" | "read" | "write" | "admin";

export interface APIKeyRecord {
  apiKey: string;
  keyId: string;
  name: string;
  enabled: boolean;
  scopes: Scope[];
  retentionDays: number;
  createdAt: string;
}

interface Row {
  api_key: string;
  key_id: string;
  name: string;
  enabled: number;
  scopes: string;
  retention_days: number;
  created_at: string;
}

// Scope hierarchy mirrors dashboard/src/lib/api-auth.ts so the two agree.
const SCOPE_HIERARCHY: Record<Scope, Scope[]> = {
  admin: ["admin", "write", "read", "ingest"],
  write: ["write", "read", "ingest"],
  read: ["read", "ingest"],
  ingest: ["ingest"],
};

// In-isolate cache, scoped to the Worker isolate. Cloudflare reuses isolates
// across many requests, so a Map populated by one request serves hits for all
// subsequent requests in the same isolate at zero D1 cost.
//
// Trade-off (unchanged from the previous KV implementation): when a key is
// disabled or deleted, warm isolates serve the stale entry for up to
// KEY_CACHE_TTL_MS. Acceptable for an ingest endpoint where compromise
// response is "rotate + redeploy", not "instant revoke".
interface CachedKey {
  record: APIKeyRecord;
  expiresAt: number;
}
const KEY_CACHE = new Map<string, CachedKey>();
export const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Test-only. Clears the module-level cache between cases. */
export function __resetKeyCache(): void {
  KEY_CACHE.clear();
}

function toRecord(row: Row): APIKeyRecord {
  return {
    apiKey: row.api_key,
    keyId: row.key_id,
    name: row.name,
    enabled: row.enabled === 1,
    scopes: parseScopes(row.scopes),
    retentionDays: row.retention_days,
    createdAt: row.created_at,
  };
}

export function parseScopes(scopes: string): Scope[] {
  if (!scopes) return ["ingest"];
  return scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Scope[];
}

export function hasScope(record: APIKeyRecord, required: Scope): boolean {
  return record.scopes.some((held) =>
    SCOPE_HIERARCHY[held]?.includes(required),
  );
}

/**
 * Resolves an API key to its record. Throws on unknown or disabled keys.
 * `now` is injectable so cache-expiry behaviour is testable without fake timers.
 */
export async function validateKey(
  apiKey: string,
  db: D1Database,
  now: number = Date.now(),
): Promise<APIKeyRecord> {
  const cached = KEY_CACHE.get(apiKey);
  if (cached && cached.expiresAt > now) {
    if (!cached.record.enabled) throw new Error("API key is disabled");
    return cached.record;
  }

  const row = await db
    .prepare(
      `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
       FROM api_keys WHERE api_key = ?`,
    )
    .bind(apiKey)
    .first<Row>();

  if (!row) throw new Error("Invalid API key");

  const record = toRecord(row);
  KEY_CACHE.set(apiKey, { record, expiresAt: now + KEY_CACHE_TTL_MS });

  if (!record.enabled) throw new Error("API key is disabled");
  return record;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd workers/packages/ingest && pnpm test`
Expected: PASS — 9 tests across 2 suites.

- [ ] **Step 7: Commit**

```bash
git add workers/packages/ingest/src/keys.ts workers/packages/ingest/test workers/packages/ingest/vitest.config.ts workers/packages/ingest/package.json workers/pnpm-lock.yaml
git commit -m "feat(ingest): add D1-backed key store with scope hierarchy"
```

---

### Task 3: Route ingest auth through the D1 key store

**Files:**
- Modify: `workers/packages/ingest/src/index.ts:1-12` (types/Env), `:99-141` (cache + validateAPIKey), `:468-477` (authenticate)

**Interfaces:**
- Consumes: `validateKey`, `APIKeyRecord` from Task 2.
- Produces: `authenticate(request, env): Promise<APIKeyRecord>` — note the **changed return type**, previously `Promise<string>`. Route handlers take `source: string` unchanged and are passed `record.name`.

- [ ] **Step 1: Replace the KV binding with D1 on Env**

In `workers/packages/ingest/src/index.ts`, replace the `APIKeyEntry` interface and `Env` interface (lines 1–12) with:

```ts
// --- Types ---

import { validateKey, type APIKeyRecord } from "./keys";

interface Env {
  INGEST_QUEUE: Queue<QueuePayload>;
  KEYS_DB: D1Database;
  DISCOVERY_MODE?: string;
}
```

- [ ] **Step 2: Delete the KV cache and validateAPIKey**

Delete the entire block from the `// In-memory API key cache` comment through the end of `validateAPIKey` (the `CachedKey` interface, `KEY_CACHE`, `KEY_CACHE_TTL_MS`, and `async function validateAPIKey`). That logic now lives in `keys.ts`.

Discovery mode is intentionally dropped with it: it auto-provisioned keys into KV, production runs it `false`, and re-adding it would give the Worker a second write path into the registry. Task 8 removes the now-dead `DISCOVERY_MODE` documentation.

- [ ] **Step 3: Update authenticate to return the record**

Replace `authenticate` (formerly lines 468–477):

```ts
async function authenticate(
  request: Request,
  env: Env,
): Promise<APIKeyRecord> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  try {
    return await validateKey(apiKey, env.KEYS_DB);
  } catch {
    throw new AuthError(403, "Invalid or disabled API key");
  }
}
```

- [ ] **Step 4: Update the fetch handler to pass the name through**

In the `fetch` handler, replace the authenticate block:

```ts
    // Authenticate
    let key: APIKeyRecord;
    try {
      key = await authenticate(request, env);
    } catch (e) {
      if (e instanceof AuthError) return errorResponse(e.status, e.message);
      return errorResponse(500, "Internal error");
    }
    const source = key.name;
```

Every existing `handleCLEF(request, env, source)` / `handleWebhook` / `handleOTLP` call is unchanged — `source` is still a string.

- [ ] **Step 5: Typecheck**

Run: `cd workers/packages/ingest && pnpm exec tsc --noEmit`
Expected: no errors. If `API_KEYS` is still referenced anywhere, remove it.

- [ ] **Step 6: Run the tests**

Run: `cd workers/packages/ingest && pnpm test`
Expected: PASS — Task 2's suites still green.

- [ ] **Step 7: Commit**

```bash
git add workers/packages/ingest/src/index.ts
git commit -m "refactor(ingest): validate API keys against D1 instead of KV"
```

---

### Task 4: Seed D1 from the live KV and ClickHouse registries

**Files:**
- Create: `scripts/seed-d1-keys.mjs`
- Create: `scripts/README.md`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure Node script).
- Produces: seed SQL on stdout. Emits `INSERT ... ON CONFLICT(api_key) DO UPDATE` so re-running is idempotent.

**Why KV is the authoritative seed:** KV is what actually authenticates production traffic today. ClickHouse contributes only `scopes` and `retention_days`, and contributes rows for keys that never worked.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-d1-keys.mjs`:

```js
#!/usr/bin/env node
// Builds idempotent seed SQL for the D1 api_keys table from the two legacy
// registries. KV is authoritative for existence and name (it is what
// authenticates live traffic); ClickHouse contributes scopes and retention.
//
// Usage:
//   node scripts/seed-d1-keys.mjs --kv .seed-kv.json --clickhouse .seed-ch.json > .seed.sql
//
// --kv         JSON array of { key, value } where value is the KV JSON string
//              or object: { name, enabled }
// --clickhouse JSON array of rows from:
//              SELECT key_id, name, api_key, enabled, scopes, retention_days,
//                     toString(created_at) AS created_at FROM logs.api_keys

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) {
    throw new Error(`missing required flag ${flag}`);
  }
  return process.argv[i + 1];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildSeed(kvEntries, chRows) {
  const chByKey = new Map();
  for (const row of chRows) chByKey.set(row.api_key, row);

  const statements = [];
  const seen = new Set();

  for (const entry of kvEntries) {
    const value =
      typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
    const ch = chByKey.get(entry.key);

    // KV wins on name only when ClickHouse has no row; a human-set ClickHouse
    // name is preferred over a generated discovered-* label.
    const name =
      ch && !String(value.name).startsWith("discovered-")
        ? value.name
        : (ch?.name ?? value.name);

    statements.push({
      apiKey: entry.key,
      keyId: ch?.key_id ?? randomUUID(),
      name,
      enabled: value.enabled === false ? 0 : 1,
      scopes: ch?.scopes || "ingest",
      retentionDays: Number(ch?.retention_days ?? 0),
      createdAt: ch?.created_at ?? new Date(0).toISOString(),
    });
    seen.add(entry.key);
  }

  // ClickHouse-only keys never authenticated (this is the bug being fixed).
  // Carry them forward enabled so UI-created keys start working.
  for (const row of chRows) {
    if (seen.has(row.api_key)) continue;
    statements.push({
      apiKey: row.api_key,
      keyId: row.key_id,
      name: row.name,
      enabled: Number(row.enabled) === 0 ? 0 : 1,
      scopes: row.scopes || "ingest",
      retentionDays: Number(row.retention_days ?? 0),
      createdAt: row.created_at,
    });
  }

  return statements
    .map(
      (s) =>
        `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES (` +
        [
          sqlString(s.apiKey),
          sqlString(s.keyId),
          sqlString(s.name),
          s.enabled,
          sqlString(s.scopes),
          s.retentionDays,
          sqlString(s.createdAt),
        ].join(", ") +
        `) ON CONFLICT(api_key) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, ` +
        `scopes=excluded.scopes, retention_days=excluded.retention_days;`,
    )
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kv = JSON.parse(readFileSync(arg("--kv"), "utf8"));
  const ch = JSON.parse(readFileSync(arg("--clickhouse"), "utf8"));
  process.stdout.write(buildSeed(kv, ch) + "\n");
}
```

- [ ] **Step 2: Export the live KV registry**

```bash
cd workers
export CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id>
NS=<kv-namespace-id-from-env-production-block>
pnpm --filter @log-cannon/ingest exec wrangler kv key list --namespace-id=$NS --remote \
  | jq -r '.[].name' > /tmp/kvkeys.txt

: > ../scripts/.seed-kv.json.tmp
while read -r k; do
  v=$(pnpm --filter @log-cannon/ingest exec wrangler kv key get --namespace-id=$NS --remote "$k" 2>/dev/null | tail -1)
  jq -nc --arg k "$k" --arg v "$v" '{key:$k, value:$v}' >> ../scripts/.seed-kv.json.tmp
done < /tmp/kvkeys.txt
jq -s '.' ../scripts/.seed-kv.json.tmp > ../scripts/.seed-kv.json
rm ../scripts/.seed-kv.json.tmp
```

Expected: `jq length scripts/.seed-kv.json` matches `wc -l < /tmp/kvkeys.txt`.

- [ ] **Step 3: Export the ClickHouse registry**

From the dashboard host (or any client that can reach ClickHouse), run and save as `scripts/.seed-ch.json`:

```sql
SELECT key_id, name, api_key, enabled, scopes, retention_days,
       toString(created_at) AS created_at
FROM logs.api_keys
FORMAT JSON
```

Save the `.data` array only. Verify: `jq 'length' scripts/.seed-ch.json`.

- [ ] **Step 4: Generate and eyeball the seed SQL**

```bash
node scripts/seed-d1-keys.mjs --kv scripts/.seed-kv.json --clickhouse scripts/.seed-ch.json > scripts/.seed.sql
grep -c "^INSERT" scripts/.seed.sql
```

Expected: the count equals the union of both registries. Confirm no `discovered-` name survives where ClickHouse supplied a real one.

- [ ] **Step 5: Apply the seed to production D1**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler d1 execute log-cannon-keys \
  --env production --remote --file ../scripts/.seed.sql
```

- [ ] **Step 6: Assert every live KV key exists in D1**

This is the gate that makes Task 5's deploy safe.

```bash
cd workers
export CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id>
pnpm --filter @log-cannon/ingest exec wrangler d1 execute log-cannon-keys \
  --env production --remote --json \
  --command "SELECT api_key FROM api_keys WHERE enabled = 1" \
  | jq -r '.[0].results[].api_key' | sort > /tmp/d1keys.txt
sort /tmp/kvkeys.txt > /tmp/kvkeys.sorted.txt
comm -23 /tmp/kvkeys.sorted.txt /tmp/d1keys.txt
```

Expected: **empty output.** Any line printed is a key that authenticates today and would break on deploy — stop and fix the seed before continuing.

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-d1-keys.mjs scripts/README.md
git commit -m "feat(scripts): add idempotent D1 key seed generator"
```

Confirm `git status` shows no `.seed-*` files staged — they contain live key values and this repo is public.

---

### Task 5: Deploy the Worker on D1 and verify live ingest

**Files:**
- Modify: none (deploy of Tasks 1–4).

**Interfaces:**
- Consumes: seeded D1 from Task 4, Worker code from Task 3.
- Produces: production ingest authenticating from D1.

- [ ] **Step 1: Record the current version for rollback**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler deployments list --env production | head -20
```

Record the current version id. Rollback is `wrangler rollback <version-id> --env production`.

- [ ] **Step 2: Deploy**

```bash
cd workers
CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler deploy --env production
```

Expected: deploys as `log-cannon-ingest` with a `KEYS_DB` D1 binding listed in the output.

- [ ] **Step 3: Verify a known-good key still authenticates**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://logs.redleg.dev/ingest/clef \
  -H "X-Seq-ApiKey: <an-existing-working-key>" \
  -H "Content-Type: application/json" \
  --data '{"@t":"2026-08-06T00:00:00Z","@mt":"d1 cutover probe"}'
```

Expected: **`201`** — `/ingest/clef` returns 201 with `{"MinimumLevelAccepted":null}`, which is the Seq API contract, not 200. Do not read 201 as a failure and roll back.

- [ ] **Step 4: Verify an unknown key is rejected**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://logs.redleg.dev/ingest/clef \
  -H "X-Seq-ApiKey: definitely-not-a-real-key" \
  -H "Content-Type: application/json" --data '{"@t":"2026-08-06T00:00:00Z","@mt":"x"}'
```

Expected: `403`. A `200` means discovery mode leaked back in — roll back.

- [ ] **Step 5: Confirm live producers are still flowing**

Wait 5 minutes (one cache TTL), then query:

```sql
SELECT source, count() AS events, max(timestamp) AS last_seen
FROM logs.events
WHERE timestamp > now() - INTERVAL 10 MINUTE
GROUP BY source ORDER BY last_seen DESC
```

Expected: the high-volume sources present before the deploy are still reporting. A source that has gone silent is a seed gap — roll back and fix.

- [ ] **Step 6: Backfill the renamed source's history**

Run this **only after** Step 5 confirms live producers are healthy. The seed renames the PEPOCS key from its generated `discovered-DDXKgcKt` label to `PEPOCS`, so events written from the cutover forward carry the new name. Backfilling closes the split.

Repo owner decided: rename **and** backfill. Only this one source needs it — the other eight `discovered-*` sources are dormant (last activity April/June 2026) and are left alone.

```sql
-- ~70,892 rows as of 2026-08-06.
ALTER TABLE logs.events UPDATE source = 'PEPOCS' WHERE source = 'discovered-DDXKgcKt'
```

ClickHouse mutations are asynchronous. Confirm completion before declaring the task done:

```sql
SELECT is_done, parts_to_do FROM system.mutations
WHERE table = 'events' ORDER BY create_time DESC LIMIT 1
```

Expected: `is_done = 1`. Then verify the split is closed:

```sql
SELECT source, count() FROM logs.events
WHERE source IN ('PEPOCS', 'discovered-DDXKgcKt') GROUP BY source
```

Expected: one row, `PEPOCS`. A surviving `discovered-DDXKgcKt` row count means the mutation is still running — re-check `system.mutations` rather than re-issuing the ALTER.

- [ ] **Step 7: Commit the deploy note**

No code change. Record the deployed version id in the PR/issue thread for rollback reference.

---

### Task 6: Worker admin API at /v1/keys

**Files:**
- Create: `workers/packages/ingest/src/admin.ts`
- Create: `workers/packages/ingest/test/admin.test.ts`
- Modify: `workers/packages/ingest/src/index.ts` (routing)
- Modify: `workers/packages/ingest/src/keys.ts` (write functions)

**Interfaces:**
- Consumes: `validateKey`, `hasScope`, `APIKeyRecord` from Task 2.
- Produces:
  - In `keys.ts`: `listKeys(db)`, `createKey(db, name, scopes, generateKey?, now?)`, `updateKey(db, keyId, patch)`, `deleteKey(db, keyId)`.
  - In `admin.ts`: `handleAdminKeys(request: Request, db: D1Database, key: APIKeyRecord): Promise<Response>`.
  - Routes: `GET/POST /v1/keys`, `PATCH/DELETE /v1/keys/:id`. All require `admin` scope.

**Routing gotcha:** `index.ts` rejects every non-POST request with 405 *before* routing. The admin routes must be dispatched **above** that check, or `GET`, `PATCH`, and `DELETE` will 405.

- [ ] **Step 1: Write the failing tests**

Create `workers/packages/ingest/test/admin.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetKeyCache } from "../src/keys";

async function seed(apiKey: string, scopes: string) {
  await env.KEYS_DB.prepare(
    `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
     VALUES (?, ?, ?, 1, ?, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(apiKey, `id-${apiKey}`, `name-${apiKey}`, scopes)
    .run();
}

describe("/v1/keys", () => {
  beforeEach(async () => {
    __resetKeyCache();
    await env.KEYS_DB.prepare("DELETE FROM api_keys").run();
    await seed("admin-key", "admin");
    await seed("ingest-key", "ingest");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await SELF.fetch("https://x/v1/keys");
    expect(res.status).toBe(401);
  });

  it("rejects an ingest-scoped key", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      headers: { "X-Api-Key": "ingest-key" },
    });
    expect(res.status).toBe(403);
  });

  it("lists keys for an admin key", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      headers: { "X-Api-Key": "admin-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(2);
  });

  it("creates a key that immediately authenticates ingest", async () => {
    const created = await SELF.fetch("https://x/v1/keys", {
      method: "POST",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Service", scopes: "ingest" }),
    });
    expect(created.status).toBe(201);
    const { apiKey } = (await created.json()) as { apiKey: string };

    // This is the regression test for the original dual-store bug.
    const ingested = await SELF.fetch("https://x/ingest/clef", {
      method: "POST",
      headers: { "X-Seq-ApiKey": apiKey, "Content-Type": "application/json" },
      body: '{"@t":"2026-08-06T00:00:00Z","@mt":"hello"}',
    });
    // 201 with {"MinimumLevelAccepted":null} is the Seq API contract for a
    // successful CLEF ingest — see handleCLEF. Not 200.
    expect(ingested.status).toBe(201);
  });

  it("rejects an invalid scope on create", async () => {
    const res = await SELF.fetch("https://x/v1/keys", {
      method: "POST",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", scopes: "root" }),
    });
    expect(res.status).toBe(400);
  });

  it("disables a key via PATCH", async () => {
    const res = await SELF.fetch("https://x/v1/keys/id-ingest-key", {
      method: "PATCH",
      headers: { "X-Api-Key": "admin-key", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const row = await env.KEYS_DB.prepare(
      "SELECT enabled FROM api_keys WHERE key_id = 'id-ingest-key'",
    ).first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("deletes a key", async () => {
    const res = await SELF.fetch("https://x/v1/keys/id-ingest-key", {
      method: "DELETE",
      headers: { "X-Api-Key": "admin-key" },
    });
    expect(res.status).toBe(200);

    const row = await env.KEYS_DB.prepare(
      "SELECT enabled FROM api_keys WHERE key_id = 'id-ingest-key'",
    ).first();
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd workers/packages/ingest && pnpm test admin`
Expected: FAIL — routes return 405/404.

- [ ] **Step 3: Add write functions to keys.ts**

Append to `workers/packages/ingest/src/keys.ts`:

```ts
export const VALID_SCOPES: Scope[] = ["ingest", "read", "write", "admin"];

export function invalidScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !VALID_SCOPES.includes(s as Scope));
}

/** 32 chars of base62, matching the dashboard's historical key format. */
export function generateAPIKey(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function listKeys(db: D1Database): Promise<APIKeyRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT api_key, key_id, name, enabled, scopes, retention_days, created_at
       FROM api_keys ORDER BY created_at DESC`,
    )
    .all<Row>();
  return results.map(toRecord);
}

export async function createKey(
  db: D1Database,
  name: string,
  scopes: string,
  now: string = new Date().toISOString(),
): Promise<APIKeyRecord> {
  const apiKey = generateAPIKey();
  const keyId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
       VALUES (?, ?, ?, 1, ?, 0, ?)`,
    )
    .bind(apiKey, keyId, name, scopes, now)
    .run();

  return {
    apiKey,
    keyId,
    name,
    enabled: true,
    scopes: parseScopes(scopes),
    retentionDays: 0,
    createdAt: now,
  };
}

export interface KeyPatch {
  name?: string;
  enabled?: boolean;
  scopes?: string;
  retentionDays?: number;
}

export async function updateKey(
  db: D1Database,
  keyId: string,
  patch: KeyPatch,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(patch.enabled ? 1 : 0);
  }
  if (patch.scopes !== undefined) {
    sets.push("scopes = ?");
    binds.push(patch.scopes);
  }
  if (patch.retentionDays !== undefined) {
    sets.push("retention_days = ?");
    binds.push(patch.retentionDays);
  }
  if (sets.length === 0) return false;

  binds.push(keyId);
  const result = await db
    .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ?`)
    .bind(...binds)
    .run();

  // A mutated key may be cached in this isolate; drop the whole cache rather
  // than track key_id → api_key. Other isolates still honour the TTL.
  KEY_CACHE.clear();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteKey(
  db: D1Database,
  keyId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM api_keys WHERE key_id = ?")
    .bind(keyId)
    .run();
  KEY_CACHE.clear();
  return (result.meta.changes ?? 0) > 0;
}
```

- [ ] **Step 4: Implement the admin handlers**

Create `workers/packages/ingest/src/admin.ts`:

```ts
import {
  createKey,
  deleteKey,
  hasScope,
  invalidScopes,
  listKeys,
  parseScopes,
  updateKey,
  type APIKeyRecord,
} from "./keys";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Admin API for the key registry. This is the only write path into `api_keys`
 * — the dashboard calls it rather than writing a store of its own, so the
 * path that creates a key is the path that authenticates it.
 */
export async function handleAdminKeys(
  request: Request,
  db: D1Database,
  key: APIKeyRecord,
): Promise<Response> {
  if (!hasScope(key, "admin")) {
    return json({ error: "admin scope required" }, 403);
  }

  const path = new URL(request.url).pathname;
  const keyId = path.startsWith("/v1/keys/")
    ? decodeURIComponent(path.slice("/v1/keys/".length))
    : null;

  if (!keyId) {
    if (request.method === "GET") {
      const keys = await listKeys(db);
      return json({ keys });
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        name?: string;
        scopes?: string | string[];
      } | null;

      if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
        return json({ error: "name is required" }, 400);
      }

      const scopeList = Array.isArray(body.scopes)
        ? body.scopes
        : parseScopes(body.scopes ?? "ingest");
      const bad = invalidScopes(scopeList);
      if (bad.length > 0) {
        return json({ error: `Invalid scopes: ${bad.join(", ")}` }, 400);
      }

      const created = await createKey(db, body.name.trim(), scopeList.join(","));
      return json(created, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  if (request.method === "PATCH") {
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      enabled?: boolean;
      scopes?: string | string[];
      retentionDays?: number;
    } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);

    if (body.scopes !== undefined) {
      const scopeList = Array.isArray(body.scopes)
        ? body.scopes
        : parseScopes(body.scopes);
      const bad = invalidScopes(scopeList);
      if (bad.length > 0) {
        return json({ error: `Invalid scopes: ${bad.join(", ")}` }, 400);
      }
      body.scopes = scopeList.join(",");
    }

    if (
      body.retentionDays !== undefined &&
      (!Number.isInteger(body.retentionDays) || body.retentionDays < 0)
    ) {
      return json({ error: "retentionDays must be an integer >= 0" }, 400);
    }

    const changed = await updateKey(db, keyId, {
      name: body.name,
      enabled: body.enabled,
      scopes: body.scopes as string | undefined,
      retentionDays: body.retentionDays,
    });
    if (!changed) return json({ error: "Key not found or no fields to update" }, 404);
    return json({ success: true });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteKey(db, keyId);
    if (!deleted) return json({ error: "Key not found" }, 404);
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
```

- [ ] **Step 5: Dispatch admin routes above the POST-only gate**

In `workers/packages/ingest/src/index.ts`, add the import:

```ts
import { handleAdminKeys } from "./admin";
```

Then in the `fetch` handler, insert this **immediately after** the `/health` check and **before** the `if (request.method !== "POST")` gate:

```ts
    // Admin API. Must be dispatched before the POST-only gate below, which
    // would otherwise 405 the GET/PATCH/DELETE verbs this API needs.
    if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
      let adminKey: APIKeyRecord;
      try {
        adminKey = await authenticate(request, env);
      } catch (e) {
        if (e instanceof AuthError) return errorResponse(e.status, e.message);
        return errorResponse(500, "Internal error");
      }
      return await handleAdminKeys(request, env.KEYS_DB, adminKey);
    }
```

Note `/v1/logs` and `/v1/traces` are matched later and are unaffected — `/v1/keys` does not prefix-collide with them.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd workers/packages/ingest && pnpm test`
Expected: PASS — all suites, including "creates a key that immediately authenticates ingest".

- [ ] **Step 7: Typecheck and deploy**

```bash
cd workers/packages/ingest && pnpm exec tsc --noEmit
cd .. && CLOUDFLARE_ACCOUNT_ID=<red-leg-dev-account-id> \
  pnpm --filter @log-cannon/ingest exec wrangler deploy --env production
```

- [ ] **Step 8: Commit**

```bash
git add workers/packages/ingest/src workers/packages/ingest/test
git commit -m "feat(ingest): add admin API for the key registry at /v1/keys"
```

---

### Task 7: Point the dashboard at the Worker admin API

**Files:**
- Create: `dashboard/src/lib/key-registry.ts`
- Modify: `dashboard/src/app/api/keys/route.ts`
- Modify: `dashboard/src/lib/clickhouse.ts` (remove key CRUD, lines ~284–385)
- Modify: `docker-compose.yml` (dashboard service env)
- Modify: `.env.example`

**Interfaces:**
- Consumes: the `/v1/keys` API from Task 6.
- Produces: `listKeys()`, `createKey(name, scopes)`, `updateKey(keyId, patch)`, `deleteKey(keyId)` from `key-registry.ts`, returning the Worker's JSON shapes.

- [ ] **Step 1: Add the registry client**

Create `dashboard/src/lib/key-registry.ts`:

```ts
// Client for the ingest Worker's key registry admin API. The dashboard does
// not own a key store — D1 behind the Worker is the sole source of truth.

const INGEST_URL = process.env.LOG_CANNON_INGEST_URL ?? 'https://logs.redleg.dev';
const ADMIN_KEY = process.env.LOG_CANNON_ADMIN_KEY ?? '';

export interface KeyRecord {
  apiKey: string;
  keyId: string;
  name: string;
  enabled: boolean;
  scopes: string[];
  retentionDays: number;
  createdAt: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!ADMIN_KEY) {
    throw new Error('LOG_CANNON_ADMIN_KEY is not configured');
  }

  const res = await fetch(`${INGEST_URL}${path}`, {
    ...init,
    headers: {
      'X-Api-Key': ADMIN_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Key registry returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listKeys(): Promise<KeyRecord[]> {
  const { keys } = await call<{ keys: KeyRecord[] }>('/v1/keys');
  return keys;
}

export async function createKey(name: string, scopes: string): Promise<KeyRecord> {
  return call<KeyRecord>('/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name, scopes }),
  });
}

export async function updateKey(
  keyId: string,
  patch: { name?: string; enabled?: boolean; scopes?: string; retentionDays?: number }
): Promise<void> {
  await call(`/v1/keys/${encodeURIComponent(keyId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteKey(keyId: string): Promise<void> {
  await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: Rewrite the UI key route against the registry**

Replace the whole of `dashboard/src/app/api/keys/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { listKeys, createKey, updateKey, deleteKey } from '@/lib/key-registry';

const VALID_SCOPES = ['ingest', 'read', 'write', 'admin'];

function fail(error: unknown, fallback: string) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 }
  );
}

export async function GET() {
  try {
    return NextResponse.json(await listKeys());
  } catch (error) {
    return fail(error, 'Failed to fetch API keys');
  }
}

function normalizeScopes(scopes: unknown): string | NextResponse {
  if (scopes === undefined) return 'ingest';
  const list = typeof scopes === 'string' ? scopes.split(',').map(s => s.trim()) : (scopes as string[]);
  const invalid = list.filter(s => !VALID_SCOPES.includes(s));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Invalid scopes: ${invalid.join(', ')}` }, { status: 400 });
  }
  return list.join(',');
}

export async function POST(request: NextRequest) {
  try {
    const { name, scopes } = await request.json();
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const scopesStr = normalizeScopes(scopes);
    if (scopesStr instanceof NextResponse) return scopesStr;

    const created = await createKey(name, scopesStr);
    return NextResponse.json({ apiKey: created.apiKey, scopes: created.scopes.join(',') });
  } catch (error) {
    return fail(error, 'Failed to create API key');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { keyId, enabled, name, scopes, retentionDays } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }

    const patch: { name?: string; enabled?: boolean; scopes?: string; retentionDays?: number } = {};

    if (retentionDays !== undefined) {
      const days = Number(retentionDays);
      if (!Number.isInteger(days) || days < 0) {
        return NextResponse.json({ error: 'retentionDays must be an integer >= 0' }, { status: 400 });
      }
      patch.retentionDays = days;
    }
    if (typeof name === 'string') {
      if (!name.trim()) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      }
      patch.name = name.trim();
    }
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (scopes !== undefined) {
      const scopesStr = normalizeScopes(scopes);
      if (scopesStr instanceof NextResponse) return scopesStr;
      patch.scopes = scopesStr;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Either enabled, name, scopes, or retentionDays is required' },
        { status: 400 }
      );
    }

    await updateKey(keyId, patch);
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, 'Failed to update API key');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { keyId } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }
    await deleteKey(keyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, 'Failed to delete API key');
  }
}
```

- [ ] **Step 3: Leave the ClickHouse key CRUD in place for now**

Do **not** delete `getAPIKeys`, `createAPIKey`, `toggleAPIKey`, `renameAPIKey`, `deleteAPIKey`, `setAPIKeyRetention`, or `generateAPIKey` from `dashboard/src/lib/clickhouse.ts` yet. `api-auth.ts`, `mcp/route.ts`, and the `v1/keys` routes still call into that path and do not migrate until Task 8. Removing them here would break the dashboard build mid-plan.

They become dead code at the end of this task and are deleted in Task 8 Step 5, once the last consumer is migrated.

- [ ] **Step 4: Wire the dashboard credentials**

In `docker-compose.yml`, add to the `dashboard` service's `environment:` block:

```yaml
      - LOG_CANNON_INGEST_URL=${LOG_CANNON_INGEST_URL:-https://logs.redleg.dev}
      - LOG_CANNON_ADMIN_KEY=${LOG_CANNON_ADMIN_KEY}
```

In `.env.example`, under the Edge ingestion section:

```
# Key registry — the dashboard manages keys through the ingest Worker's admin
# API rather than owning a store of its own. Must be an admin-scoped key.
LOG_CANNON_INGEST_URL=https://logs.example.com
LOG_CANNON_ADMIN_KEY=your-admin-scoped-api-key
```

Set the real value in the deployment's `.env` (an existing `admin`-scoped key). Do not commit it.

- [ ] **Step 5: Build the dashboard**

Run: `cd dashboard && npm run build`
Expected: build succeeds. Any error naming a deleted `clickhouse.ts` export is a missed call site — Task 8 handles `api-auth.ts` and `mcp/route.ts`; fix any others here.

- [ ] **Step 6: Verify end to end against production**

Redeploy the dashboard stack, then in the UI create a key named `d1-cutover-probe` and immediately:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://logs.redleg.dev/ingest/clef \
  -H "X-Seq-ApiKey: <the-new-key>" -H "Content-Type: application/json" \
  --data '{"@t":"2026-08-06T00:00:00Z","@mt":"probe"}'
```

Expected: `200`. **This is the bug being fixed** — before this change it returned 403. Then delete the probe key in the UI.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/key-registry.ts dashboard/src/app/api/keys/route.ts dashboard/src/lib/clickhouse.ts docker-compose.yml .env.example
git commit -m "feat(dashboard): manage API keys through the Worker registry API"
```

---

### Task 8: Migrate remaining dashboard consumers and update docs

**Files:**
- Modify: `dashboard/src/lib/api-auth.ts:70-90`
- Modify: `dashboard/src/app/api/mcp/route.ts:30-40`
- Modify: `dashboard/src/app/api/v1/keys/route.ts`, `dashboard/src/app/api/v1/keys/[id]/route.ts`
- Modify: `AGENTS.md:47`
- Modify: `README.md` §"Edge Ingestion Setup"

**Interfaces:**
- Consumes: `listKeys` from Task 7's `key-registry.ts`.
- Produces: `authenticateApiKey(request, requiredScope)` with an unchanged signature and return type, so no call site changes.

- [ ] **Step 1: Add a cached lookup to the registry client**

Append to `dashboard/src/lib/key-registry.ts`:

```ts
// Short-lived cache so per-request dashboard API auth does not make an edge
// round-trip on every call. Deliberately shorter than the Worker's 5-minute
// isolate cache — dashboard auth guards read/write/admin, not ingest.
const AUTH_CACHE_TTL_MS = 30_000;
let authCache: { keys: KeyRecord[]; expiresAt: number } | null = null;

export async function lookupKey(apiKey: string): Promise<KeyRecord | null> {
  const now = Date.now();
  if (!authCache || authCache.expiresAt <= now) {
    authCache = { keys: await listKeys(), expiresAt: now + AUTH_CACHE_TTL_MS };
  }
  return authCache.keys.find(k => k.apiKey === apiKey) ?? null;
}

export function __resetAuthCache(): void {
  authCache = null;
}
```

- [ ] **Step 2: Point api-auth.ts at the registry**

In `dashboard/src/lib/api-auth.ts`, replace the `queryClickHouse` import with:

```ts
import { lookupKey } from './key-registry';
```

Then replace the body of the lookup inside `authenticateApiKey` — the `SELECT ... FROM logs.api_keys` query and its row handling — with:

```ts
  const record = await lookupKey(apiKey);
  if (!record || !record.enabled) {
    return apiError('unauthorized', 'Invalid or disabled API key', 401);
  }

  const scopes = record.scopes as ApiScope[];
  if (!hasScope(scopes, requiredScope)) {
    return apiError(
      'forbidden',
      `This key lacks the required '${requiredScope}' scope`,
      403
    );
  }

  return { keyId: record.keyId, keyName: record.name, scopes };
```

Keep `parseScopes`, `hasScope`, `SCOPE_HIERARCHY`, and `apiError` as they are.

- [ ] **Step 3: Point the MCP route at the registry**

In `dashboard/src/app/api/mcp/route.ts`, replace the `FROM logs.api_keys` query (around line 34) with a `lookupKey(apiKey)` call, using the same enabled/scope checks as Step 2.

- [ ] **Step 4: Point the v1 key routes at the registry**

In `dashboard/src/app/api/v1/keys/route.ts` and `dashboard/src/app/api/v1/keys/[id]/route.ts`, replace each `ALTER TABLE logs.api_keys` / `INSERT INTO logs.api_keys` statement with the corresponding `createKey` / `updateKey` / `deleteKey` / `listKeys` call from `@/lib/key-registry`. Authentication via `authenticateApiKey` is unchanged.

- [ ] **Step 5: Remove the now-dead ClickHouse key CRUD**

Every consumer has moved, so delete `getAPIKeys`, `createAPIKey`, `toggleAPIKey`, `renameAPIKey`, `deleteAPIKey`, `setAPIKeyRetention`, and `generateAPIKey` from `dashboard/src/lib/clickhouse.ts` (roughly lines 284–385). Leave everything else in that file untouched.

Then verify no references remain:

```bash
grep -rn "logs.api_keys" dashboard/src
grep -rn "createAPIKey\|toggleAPIKey\|renameAPIKey\|deleteAPIKey\|setAPIKeyRetention\|getAPIKeys" dashboard/src
```

Expected: no output from either.

- [ ] **Step 6: Update the agent and self-hoster docs**

In `AGENTS.md`, replace line 47 with:

```markdown
- **API keys live in D1, behind the ingest Worker.** The Worker owns the only write path (`/v1/keys`, admin scope); the dashboard is a client of it. Never add a second key store — that dual-homing was the bug this replaced. See `docs/superpowers/specs/2026-08-06-api-key-registry-d1-design.md`.
```

In `README.md` §"Edge Ingestion Setup", replace step 2 ("Populate API keys in KV") and its bulk-sync snippet with:

```markdown
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
```

Update the §3 config snippet to show the `[[d1_databases]]` binding instead of `[[kv_namespaces]]`, and remove the `DISCOVERY_MODE` line from `.env.example` along with its comment.

- [ ] **Step 7: Build and test**

```bash
cd dashboard && npm run build
cd ../workers/packages/ingest && pnpm test
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src AGENTS.md README.md .env.example
git commit -m "refactor(dashboard): read key auth from the registry; document D1 as sole store"
```

---

## Done when

- Creating a key in the dashboard UI produces a key that authenticates `POST /ingest/clef` immediately. Covered by a test in `test/admin.test.ts` and verified live in Task 7 Step 6.
- `grep -rn "logs.api_keys" dashboard/src` returns nothing.
- All previously-live sources are still ingesting (Task 5 Step 5).
- `pnpm test` in `workers/packages/ingest` is green.

## Deferred to Plan 2

- `logs.key_policies` projection and the `retention-worker` switch.
- Retention keyed on observed `source` rather than key name (the latent defect in the spec).
- Dropping ClickHouse `logs.api_keys` and deleting the KV namespace.
- Deciding, per source, whether to backfill `events.source` for renamed `discovered-*` keys.

Until Plan 2 lands, `retention-worker` still reads ClickHouse `logs.api_keys`, which is now frozen — retention behaviour is unchanged from today, neither better nor worse.

---

## Addendum: retention projection (Tasks 9–10)

Task 8 introduced a regression. The dashboard's retention control now writes `retentionDays` to D1, but `retention-worker/main.go:110` still reads `retention_days` from ClickHouse `logs.api_keys`, which is now frozen. Existing policies (21 keys at 21 days) keep working because the frozen table retains its values; **new edits are inert and newly created keys have no ClickHouse row at all, so their logs are never trimmed.**

The repo owner chose to pull the projection forward from Plan 2 rather than ship the regression documented.

**Why this is two tasks, not one.** Restoring the control (Task 9) and fixing the pre-existing source-matching bug (Task 10) are separable, and Task 9 alone closes the regression. Task 10 is the larger piece: retention today is a property of a *key*, but `events.source` can be overridden per-event by an OTLP `service.name` or a webhook preset, so a key-derived policy can never match those sources. Fixing that means configuring retention against observed sources, which is new UI.

---

### Task 9: `logs.key_policies` projection, retention-worker reads it

**Files:**
- Create: `dashboard/src/lib/key-policies.ts`
- Modify: `dashboard/src/app/api/keys/route.ts`, `dashboard/src/app/api/v1/keys/route.ts`, `dashboard/src/app/api/v1/keys/[id]/route.ts`
- Modify: `retention-worker/main.go:102-131`
- Create: `clickhouse/init/009_key_policies.sql`

**Interfaces:**
- Produces `syncKeyPolicies(): Promise<void>` — idempotent; creates the table if absent, then replaces its contents from the D1 registry.

**Schema.** `ReplacingMergeTree` keyed by `source`, so repeated syncs collapse rather than accumulate. The table is tiny (one row per key name), so `FINAL` is cheap.

```sql
CREATE TABLE IF NOT EXISTS logs.key_policies (
  source         String,
  retention_days UInt32,
  updated_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY source;
```

Per `AGENTS.md`, `clickhouse/init/*.sql` runs only on a fresh data dir, so the init file alone will not create this on the running production instance. `syncKeyPolicies()` therefore issues `CREATE TABLE IF NOT EXISTS` itself before writing — that is deliberate, and it removes any need for a manual migration step on prod.

**Aggregation rule — preserve it exactly.** Several keys share a name (`Esferas`, `GWSC.io`, `WOTC Genius` each have two). `retention-worker` currently groups by name and takes `max(retention_days)`, documented as "the least destructive choice." The projection must apply the same rule, or a source with two keys could start being trimmed on the shorter window.

- [ ] **Step 1: Write the projection module**

Create `dashboard/src/lib/key-policies.ts`. It reads the registry via `listKeys()` and writes the projection. Group by `name`, take the max `retentionDays`, and include only positive values (0 means keep forever and must not produce a row).

- [ ] **Step 2: Call it after every key mutation**

In `dashboard/src/app/api/keys/route.ts` and both `v1/keys` routes, call `syncKeyPolicies()` after each successful POST, PATCH, and DELETE. A sync failure must not fail the mutation — the registry write already succeeded and is the source of truth. Log the failure and return success.

- [ ] **Step 3: Point retention-worker at the projection**

In `retention-worker/main.go`, replace the `fetchPolicies` query:

```go
	query := `
		SELECT source, retention_days
		FROM logs.key_policies FINAL
		WHERE retention_days > 0
	`
```

The `RetentionPolicy` struct and `trimSource` are unchanged — `Source` still maps to `events.source`.

- [ ] **Step 4: Verify**

`cd dashboard && npm run build`, then `cd retention-worker && go build ./... && go vet ./...`.

- [ ] **Step 5: Verify the projection matches today's live policy**

After deploying the dashboard, the projection must reproduce the 21 policies currently in `logs.api_keys`. Compare:

```sql
SELECT source, retention_days FROM logs.key_policies FINAL ORDER BY source
```

against the frozen `SELECT name, max(retention_days) FROM logs.api_keys WHERE enabled = 1 AND retention_days > 0 GROUP BY name`. Any source present in the old set but missing from the new one would silently stop being trimmed.

- [ ] **Step 6: Commit**

---

### Task 10: retention configured per observed source (closes the OTLP gap)

Not started. `events.source` is overridden per-event by OTLP `service.name` (`queue-consumer/otlp.go:41-43,78-80`) and webhook preset `SourceField` (`webhook.go:261`), so sources like `adrenaline-body-works`, `wagner-dashboard`, and `execupgrades-*` have no key of that name and can never match a key-derived policy. This predates the migration.

Closing it means retention stops being a key property and becomes per-source config, set in the dashboard against sources actually observed in `logs.events`. That is a UI change plus a write path into `key_policies` for sources with no corresponding key, and it should be specced on its own rather than bolted onto this plan.
