CREATE TABLE IF NOT EXISTS logs.alerts (
    id UUID DEFAULT generateUUIDv4(),
    name String,
    description String DEFAULT '',
    query String,
    condition String,
    interval_seconds UInt32 DEFAULT 60,
    cooldown_seconds UInt32 DEFAULT 300,
    recipients String DEFAULT '[]',
    subject String DEFAULT '',
    enabled UInt8 DEFAULT 1,
    created_at DateTime64(3) DEFAULT now(),
    last_triggered_at DateTime64(3) DEFAULT toDateTime64('1970-01-01 00:00:00', 3)
) ENGINE = MergeTree
ORDER BY name;
