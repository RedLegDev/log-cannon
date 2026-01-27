CREATE TABLE IF NOT EXISTS logs.dashboards (
    id UUID DEFAULT generateUUIDv4(),
    name String,
    description String DEFAULT '',
    config String,
    enabled UInt8 DEFAULT 1,
    created_at DateTime64(3) DEFAULT now(),
    updated_at DateTime64(3) DEFAULT now()
) ENGINE = MergeTree
ORDER BY name;
