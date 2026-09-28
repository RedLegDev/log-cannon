CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.api_keys (
    key_id UUID DEFAULT generateUUIDv4(),
    api_key String,
    name String,
    created_at DateTime64(3) DEFAULT now(),
    enabled UInt8 DEFAULT 1
) ENGINE = MergeTree
ORDER BY api_key;

-- Ingest is at-least-once and there is no deduplication: `id` is generated here
-- at insert time, not carried from the producer, so a redelivered queue message
-- inserts a second, indistinguishable row. The consumer retries its ack inside
-- the lease to keep that rare (refs #116), but anything counting rows should
-- assume a small over-count is possible rather than exact.
CREATE TABLE IF NOT EXISTS logs.events (
    id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3),
    level LowCardinality(String),
    message_template String,
    message String,
    exception String DEFAULT '',
    event_type String DEFAULT '',
    source String,
    properties String,
    -- When the consumer wrote the row, as opposed to `timestamp`, which is the
    -- client-stamped CLEF `@t`. The difference is ingest lag.
    --
    -- The default is the epoch sentinel, NOT now(), and that is deliberate: see
    -- 010_events_inserted_at.sql. The consumer always supplies this column, so
    -- the default only ever applies to rows written before it existed.
    inserted_at DateTime64(3) DEFAULT toDateTime64(0, 3)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (source, toStartOfHour(timestamp), level);
