-- Alert firing history (refs #193). One row per live evaluation whose
-- condition was true: delivered, held by cooldown, or failed to deliver.
-- Shadow mode writes none. Pruned by the evaluator after 90 days.
-- values_json is the evaluated first row (capped like alert_evaluations.value);
-- destinations_json is [{target, ok, error?}], one per delivery attempt.

CREATE TABLE IF NOT EXISTS alert_firings (
  id                INTEGER PRIMARY KEY,
  alert_id          TEXT NOT NULL,
  fired_at          TEXT NOT NULL,
  values_json       TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('delivered', 'cooldown', 'failed')),
  destinations_json TEXT NOT NULL DEFAULT '[]',
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_firings_alert ON alert_firings(alert_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_alert_firings_at ON alert_firings(fired_at);
