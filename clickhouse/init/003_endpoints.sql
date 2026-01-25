CREATE TABLE IF NOT EXISTS logs.endpoints (
    id UUID DEFAULT generateUUIDv4(),
    name String,
    description String DEFAULT '',
    sql_query String,
    cache_ttl_seconds UInt32 DEFAULT 0,
    enabled UInt8 DEFAULT 1,
    created_at DateTime64(3) DEFAULT now()
) ENGINE = MergeTree
ORDER BY name;
