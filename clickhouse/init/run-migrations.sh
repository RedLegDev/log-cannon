#!/bin/sh
set -e

CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://clickhouse:8123/}"

echo "Running ClickHouse migrations..."

# Run all SQL files in order
for sql_file in /init/*.sql; do
    if [ -f "$sql_file" ]; then
        echo "Executing: $sql_file"
        # Read file and execute each statement (split by semicolons)
        # Filter out empty lines and comments, then run each statement
        while IFS= read -r line || [ -n "$line" ]; do
            # Skip empty lines and comments
            case "$line" in
                ''|'--'*) continue ;;
            esac
            # Accumulate lines until we hit a semicolon
            statement="${statement}${line} "
            case "$line" in
                *\;)
                    # Remove trailing semicolon and whitespace, then execute
                    query=$(echo "$statement" | sed 's/;[[:space:]]*$//')
                    if [ -n "$query" ]; then
                        echo "  Running: $(echo "$query" | head -c 60)..."
                        curl -sf -X POST "$CLICKHOUSE_URL" -d "$query" || {
                            echo "  ERROR: Failed to execute query"
                            exit 1
                        }
                        echo "  ✓"
                    fi
                    statement=""
                    ;;
            esac
        done < "$sql_file"
        echo "✓ Completed: $sql_file"
    fi
done

echo "All migrations completed successfully."
