-- Per-service data retention.
-- retention_days controls how long logs from this API key's source are kept.
-- 0 = keep forever (default, backward-compatible). >0 = trim logs older than N days.
-- The retention-worker reads this column and runs daily ALTER ... DELETE passes.
ALTER TABLE logs.api_keys ADD COLUMN IF NOT EXISTS retention_days UInt32 DEFAULT 0;
