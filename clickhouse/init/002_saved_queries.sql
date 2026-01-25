CREATE TABLE IF NOT EXISTS logs.saved_queries (
    id UUID DEFAULT generateUUIDv4(),
    name String,
    description String DEFAULT '',
    source String DEFAULT '',
    level String DEFAULT '',
    search String DEFAULT '',
    property_filters String DEFAULT '[]',
    created_at DateTime64(3) DEFAULT now()
) ENGINE = MergeTree
ORDER BY created_at;
