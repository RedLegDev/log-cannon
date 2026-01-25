-- Create database
CREATE DATABASE IF NOT EXISTS logs;

-- API keys for authentication
CREATE TABLE IF NOT EXISTS logs.api_keys (
    key_id UUID DEFAULT generateUUIDv4(),
    api_key String,
    name String,
    created_at DateTime64(3) DEFAULT now(),
    enabled UInt8 DEFAULT 1
) ENGINE = MergeTree
ORDER BY api_key;

-- Main logs table
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

-- Index for common query patterns
ALTER TABLE logs.events ADD INDEX IF NOT EXISTS idx_level (level) TYPE set(5) GRANULARITY 1;
ALTER TABLE logs.events ADD INDEX IF NOT EXISTS idx_message (message) TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 1;
