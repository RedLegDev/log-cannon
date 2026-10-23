-- Alerts on D1, evaluated by the Worker's cron against Basin (refs #165).
-- Columns match v1's ClickHouse logs.alerts / logs.alert_destinations so ids
-- and API shapes carry over; JSON arrays are stored as TEXT, as in v1.

CREATE TABLE IF NOT EXISTS alerts (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  query                    TEXT NOT NULL,
  condition                TEXT NOT NULL,
  interval_seconds         INTEGER NOT NULL DEFAULT 60,
  cooldown_seconds         INTEGER NOT NULL DEFAULT 300,
  recipients               TEXT NOT NULL DEFAULT '[]',
  destination_ids          TEXT NOT NULL DEFAULT '[]',
  subject                  TEXT NOT NULL DEFAULT '',
  enabled                  INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  -- Live cooldown. Set only after a destination accepted the alert.
  last_triggered_at        TEXT,
  -- Shadow mode keeps its own cooldown so a shadow run never moves the live one.
  shadow_last_triggered_at TEXT,
  -- Latest evaluation: due-time bookkeeping and the health readout in GET.
  last_run_at              TEXT,
  last_status              TEXT,
  last_value               TEXT,
  last_error               TEXT
);

CREATE TABLE IF NOT EXISTS alert_destinations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- One row per evaluation: the shadow comparison record, and the history
-- behind "is this alert healthy". Pruned by the evaluator after 14 days.
CREATE TABLE IF NOT EXISTS alert_evaluations (
  alert_id     TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  mode         TEXT NOT NULL,
  status       TEXT NOT NULL,
  would_send   INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  value        TEXT,
  error        TEXT,
  duration_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alert_evaluations_alert ON alert_evaluations(alert_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_alert_evaluations_at ON alert_evaluations(evaluated_at);

-- Single-row leases for cron work, so an overrunning tick can't overlap the next.
CREATE TABLE IF NOT EXISTS cron_leases (
  name       TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
