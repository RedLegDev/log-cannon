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
