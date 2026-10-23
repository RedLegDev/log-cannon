-- Supabase platform-log pull on the Worker's cron (refs #164). The Go
-- supabase-pull derived its resume point from ClickHouse at startup; Basin
-- lags, costs a scan per read and can't json_get large rows, so the state the
-- pull needs lives here instead. Timestamps are epoch microseconds: Supabase
-- stamps rows in microseconds and the keyset must not round them.
-- One run at a time is the `supabase-pull` row in cron_leases (0002).

-- How far each (project, table) has been pulled. cursor_ts/cursor_id is the
-- newest row sent to Basin; read_to is how far the table has been read with
-- nothing left behind, which also moves through stretches with no rows.
CREATE TABLE IF NOT EXISTS supabase_pull_cursor (
  ref        TEXT NOT NULL,
  log_table  TEXT NOT NULL,
  cursor_ts  INTEGER,
  cursor_id  TEXT,
  read_to    INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ref, log_table)
);

-- Ids sent within the re-read overlap, so a row read twice is sent once.
-- Pruned to the overlap behind each table's position on every run.
CREATE TABLE IF NOT EXISTS supabase_pull_seen (
  ref       TEXT NOT NULL,
  log_table TEXT NOT NULL,
  sb_id     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (ref, log_table, sb_id)
);
CREATE INDEX IF NOT EXISTS idx_supabase_pull_seen_ts ON supabase_pull_seen(ref, log_table, ts);
