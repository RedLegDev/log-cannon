CREATE TABLE IF NOT EXISTS logs.alert_destinations (
    id UUID DEFAULT generateUUIDv4(),
    name String,
    type String,
    config String DEFAULT '{}',
    enabled UInt8 DEFAULT 1,
    created_at DateTime64(3) DEFAULT now()
) ENGINE = MergeTree
ORDER BY id;

ALTER TABLE logs.alerts
    ADD COLUMN IF NOT EXISTS destination_ids String DEFAULT '[]';
