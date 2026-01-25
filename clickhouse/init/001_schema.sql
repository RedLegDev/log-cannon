CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.api_keys (
    key_id UUID DEFAULT generateUUIDv4(),
    api_key String,
    name String,
    created_at DateTime64(3) DEFAULT now(),
    enabled UInt8 DEFAULT 1
) ENGINE = MergeTree
ORDER BY api_key;

CREATE TABLE IF NOT EXISTS logs.events (
    id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3),
    level LowCardinality(String),
    message_template String,
    message String,
    exception String DEFAULT '',
    event_type String DEFAULT '',
    source String,
    properties String
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (source, toStartOfHour(timestamp), level);
