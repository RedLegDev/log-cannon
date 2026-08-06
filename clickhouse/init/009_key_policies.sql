-- Projection of the D1 key registry's retention settings, kept in sync by
-- dashboard/src/lib/key-policies.ts after every key mutation. D1 (behind the
-- ingest Worker) is the source of truth for keys; retention-worker only
-- talks to ClickHouse, so this table is how it learns per-source retention.
--
-- One row per source (API key name), taking the max retention_days across
-- keys sharing a name. retention_days = 0 (keep forever) is never written
-- here. ReplacingMergeTree(updated_at) lets repeated syncs collapse rather
-- than accumulate; the table is tiny, so FINAL reads are cheap.
--
-- NOTE: this file only runs against a fresh data dir. The running production
-- instance was seeded before this migration existed, so
-- syncKeyPolicies() also issues this same CREATE TABLE IF NOT EXISTS at
-- runtime. Keep the two definitions identical.
CREATE TABLE IF NOT EXISTS logs.key_policies (
  source         String,
  retention_days UInt32,
  updated_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY source;
