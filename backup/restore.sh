#!/bin/bash
set -euo pipefail

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-clickhouse}"
BACKUP_DIR="/backups"
GDRIVE_DIR="/gdrive/log-cannon-backups"

log() {
    echo "[$(date -Iseconds)] $1"
}

list_backups() {
    echo ""
    echo "=== Available Backups ==="
    echo ""

    echo "Local ($BACKUP_DIR):"
    if ls -d "$BACKUP_DIR"/logs-* 2>/dev/null | sort -r | head -20; then
        :
    else
        echo "  (none)"
    fi

    echo ""
    echo "Google Drive ($GDRIVE_DIR):"
    if [ -d "$GDRIVE_DIR" ]; then
        if ls -d "$GDRIVE_DIR"/logs-* 2>/dev/null | sort -r | head -20; then
            :
        else
            echo "  (none)"
        fi
    else
        echo "  (not mounted)"
    fi
    echo ""
}

# If no argument, list backups and prompt
if [ $# -eq 0 ]; then
    list_backups
    echo "Usage: restore.sh <backup-name>"
    echo "Example: restore.sh logs-2026-03-15-030000"
    exit 0
fi

BACKUP_NAME="$1"

# Check if backup exists locally
if [ -d "$BACKUP_DIR/$BACKUP_NAME" ]; then
    log "Found backup locally: $BACKUP_DIR/$BACKUP_NAME"
elif [ -d "$GDRIVE_DIR/$BACKUP_NAME" ]; then
    log "Backup not found locally. Copying from Google Drive..."
    rsync -a "$GDRIVE_DIR/$BACKUP_NAME/" "$BACKUP_DIR/$BACKUP_NAME/"
    log "Copy complete."
else
    log "ERROR: Backup '$BACKUP_NAME' not found locally or on Google Drive."
    list_backups
    exit 1
fi

log "Restoring database from: $BACKUP_NAME"
log "WARNING: This will replace existing data in the logs database."
echo ""
echo "Press Ctrl+C within 5 seconds to abort..."
sleep 5

if clickhouse-client -h "$CLICKHOUSE_HOST" --query "RESTORE DATABASE logs FROM Disk('local_backups', '$BACKUP_NAME') SETTINGS allow_non_empty_tables=true"; then
    log "Restore completed successfully from: $BACKUP_NAME"
else
    log "ERROR: Restore failed."
    exit 1
fi

# Verify
log "Verifying restore..."
ROW_COUNT=$(clickhouse-client -h "$CLICKHOUSE_HOST" --query "SELECT count() FROM logs.events")
TABLE_COUNT=$(clickhouse-client -h "$CLICKHOUSE_HOST" --query "SELECT count() FROM system.tables WHERE database = 'logs'")
log "Verification: $TABLE_COUNT tables, $ROW_COUNT events in logs.events"
log "Restore complete."
