#!/bin/bash
set -euo pipefail

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-clickhouse}"
BACKUP_DIR="/backups"
R2_BUCKET="${R2_BUCKET:-log-cannon-backups}"
RCLONE_CONF="/root/.config/rclone/rclone.conf"

ch_query() {
    curl -sf "http://${CLICKHOUSE_HOST}:8123/" --data-binary "$1"
}

log() {
    echo "[$(date -Iseconds)] $1"
}

has_r2() {
    rclone --config "$RCLONE_CONF" listremotes 2>/dev/null | grep -q "r2:"
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
    echo "Cloudflare R2 (${R2_BUCKET}):"
    if has_r2; then
        R2_LIST=$(rclone lsd "r2:${R2_BUCKET}/" --config "$RCLONE_CONF" 2>/dev/null | awk '{print $NF}' | grep "^logs-" | sort -r | head -20)
        if [ -n "$R2_LIST" ]; then
            echo "$R2_LIST" | while read -r dir; do echo "  r2:${R2_BUCKET}/${dir}"; done
        else
            echo "  (none)"
        fi
    else
        echo "  (not configured)"
    fi
    echo ""
}

# If no argument, list backups and exit
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
elif has_r2; then
    log "Backup not found locally. Downloading from R2..."
    if rclone copy "r2:${R2_BUCKET}/${BACKUP_NAME}/" "$BACKUP_DIR/$BACKUP_NAME/" \
        --config "$RCLONE_CONF" \
        --transfers 8 \
        --progress; then
        log "Download complete."
    else
        log "ERROR: Failed to download backup from R2."
        exit 1
    fi
else
    log "ERROR: Backup '$BACKUP_NAME' not found locally and R2 is not configured."
    list_backups
    exit 1
fi

log "Restoring database from: $BACKUP_NAME"
log "WARNING: This will replace existing data in the logs database."
echo ""
echo "Press Ctrl+C within 5 seconds to abort..."
sleep 5

if ch_query "RESTORE DATABASE logs FROM Disk('local_backups', '$BACKUP_NAME') SETTINGS allow_non_empty_tables=true"; then
    log "Restore completed successfully from: $BACKUP_NAME"
else
    log "ERROR: Restore failed."
    exit 1
fi

# Verify
log "Verifying restore..."
ROW_COUNT=$(ch_query "SELECT count() FROM logs.events")
TABLE_COUNT=$(ch_query "SELECT count() FROM system.tables WHERE database = 'logs'")
log "Verification: $TABLE_COUNT tables, $ROW_COUNT events in logs.events"
log "Restore complete."
