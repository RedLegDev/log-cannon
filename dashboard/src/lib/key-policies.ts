// Projects the D1 key registry's retention settings into ClickHouse so
// retention-worker (which only talks to ClickHouse) can trim `logs.events`
// per source. D1 is the source of truth for keys; this table is a read-only
// mirror kept in sync after every key mutation.

import { listKeys } from './key-registry';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';

function escapeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function executeClickHouse(sql: string): Promise<void> {
  const response = await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse query failed: ${errorText}`);
  }
}

// `retention-worker` runs only on a fresh data dir via clickhouse/init/*.sql,
// so this table also needs to exist on the running production instance,
// which was seeded before this migration was added. Issuing
// CREATE TABLE IF NOT EXISTS here makes syncKeyPolicies self-provisioning —
// no manual migration step against prod. Keep this definition identical to
// clickhouse/init/009_key_policies.sql.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS logs.key_policies (
  source         String,
  retention_days UInt32,
  updated_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY source
`;

/**
 * Rebuilds logs.key_policies from the D1 key registry.
 *
 * Grouping: multiple keys can share a name (= source). Group by name and take
 * the max retentionDays among enabled keys — mirrors retention-worker's old
 * `max(retention_days) ... GROUP BY name`, "the least destructive choice."
 * retentionDays = 0 (keep forever) is excluded, matching the old
 * `retention_days > 0` filter.
 *
 * Removal: this must *replace*, not accumulate. A source whose retention
 * drops to 0, or whose key is deleted/disabled, must stop appearing.
 * ReplacingMergeTree(updated_at) collapses re-inserts of the same source
 * after a merge (and FINAL readers see that immediately), but it never drops
 * a source that should no longer exist at all — so after writing the current
 * set, this issues an ALTER ... DELETE for every existing source not in that
 * set. That runs against a live table, so the write ordering matters: insert
 * the fresh rows first, delete stale ones second, so there is never a window
 * where a still-valid source has no row. Deletes here run as a background
 * ClickHouse mutation, so removal is not instantaneous — the read side uses
 * FINAL, but a still-pending DELETE mutation just means a stale source keeps
 * being trimmed on its old window for a short extra window, not that it goes
 * unprotected. That's acceptable: it fails safe (over-retaining briefly),
 * never under-retaining.
 */
export async function syncKeyPolicies(): Promise<number> {
  await executeClickHouse(CREATE_TABLE_SQL);

  const keys = await listKeys();

  const maxRetentionBySource = new Map<string, number>();
  for (const key of keys) {
    if (!key.enabled) continue;
    if (!Number.isFinite(key.retentionDays) || key.retentionDays <= 0) continue;
    const current = maxRetentionBySource.get(key.name);
    if (current === undefined || key.retentionDays > current) {
      maxRetentionBySource.set(key.name, key.retentionDays);
    }
  }

  const sources = Array.from(maxRetentionBySource.keys());

  if (sources.length > 0) {
    const rows = sources
      .map(source => `('${escapeString(source)}', ${maxRetentionBySource.get(source)})`)
      .join(', ');
    await executeClickHouse(`INSERT INTO logs.key_policies (source, retention_days) VALUES ${rows}`);
  }

  const deleteWhere =
    sources.length > 0
      ? `source NOT IN (${sources.map(s => `'${escapeString(s)}'`).join(', ')})`
      : `1 = 1`;

  await executeClickHouse(`ALTER TABLE logs.key_policies DELETE WHERE ${deleteWhere}`);

  return sources.length;
}
