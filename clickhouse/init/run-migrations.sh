#!/bin/sh
set -e

CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://clickhouse:8123/}"

echo "Running ClickHouse migrations..."

# Run all SQL files in order
for sql_file in /init/*.sql; do
    if [ -f "$sql_file" ]; then
        echo "Executing: $sql_file"
        curl -sf -X POST "$CLICKHOUSE_URL" --data-binary @"$sql_file"
        echo " ✓ Done"
    fi
done

echo "All migrations completed successfully."
