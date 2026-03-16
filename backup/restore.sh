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

# Determine backup type from name or metadata
get_backup_type() {
    local name="$1"
    if [ -f "$BACKUP_DIR/$name/.backup_meta" ]; then
        grep "^type=" "$BACKUP_DIR/$name/.backup_meta" | cut -d= -f2
    elif echo "$name" | grep -q "^logs-full-"; then
        echo "full"
    elif echo "$name" | grep -q "^logs-incr-"; then
        echo "incremental"
    else
        echo "full"  # Legacy naming treated as full
    fi
}

# Get base backup name from metadata
get_base_backup() {
    local name="$1"
    if [ -f "$BACKUP_DIR/$name/.backup_meta" ]; then
        grep "^base=" "$BACKUP_DIR/$name/.backup_meta" | cut -d= -f2
    else
        echo "none"
    fi
}

# Ensure a backup exists locally, downloading from R2 if needed
ensure_local() {
    local name="$1"
    if [ -d "$BACKUP_DIR/$name" ]; then
        log "Found $name locally"
        return 0
    fi
    if has_r2; then
        log "Downloading $name from R2..."
        if rclone copy "r2:${R2_BUCKET}/${name}/" "$BACKUP_DIR/$name/" \
            --config "$RCLONE_CONF" \
            --transfers 8 \
            --progress; then
            log "Download complete: $name"
            return 0
        else
            log "ERROR: Failed to download $name from R2"
            return 1
        fi
    else
        log "ERROR: $name not found locally and R2 is not configured"
        return 1
    fi
}

list_backups() {
    echo ""
    echo "=== Available Backups ==="
    echo ""

    echo "Local ($BACKUP_DIR):"
    local locals
    locals=$(find "$BACKUP_DIR" -maxdepth 1 -type d \( -name "logs-full-*" -o -name "logs-incr-*" -o -name "logs-[0-9]*" \) 2>/dev/null | sort -r | head -20)
    if [ -n "$locals" ]; then
        echo "$locals" | while read -r dir; do
            local name
            name=$(basename "$dir")
            local type
            type=$(get_backup_type "$name")
            printf "  %-45s [%s]\n" "$name" "$type"
        done
    else
        echo "  (none)"
    fi

    echo ""
    echo "Cloudflare R2 (${R2_BUCKET}):"
    if has_r2; then
        R2_LIST=$(rclone lsd "r2:${R2_BUCKET}/" --config "$RCLONE_CONF" 2>/dev/null | awk '{print $NF}' | grep "^logs-" | sort -r | head -20)
        if [ -n "$R2_LIST" ]; then
            echo "$R2_LIST" | while read -r dir; do
                local type="full"
                echo "$dir" | grep -q "^logs-incr-" && type="incremental"
                printf "  %-45s [%s]\n" "r2:${R2_BUCKET}/${dir}" "$type"
            done
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
    echo "Example: restore.sh logs-full-2026-03-15-030000"
    echo "         restore.sh logs-incr-2026-03-15-150000"
    exit 0
fi

BACKUP_NAME="$1"

# Ensure the requested backup is local
if ! ensure_local "$BACKUP_NAME"; then
    list_backups
    exit 1
fi

BACKUP_TYPE=$(get_backup_type "$BACKUP_NAME")
BASE_BACKUP=$(get_base_backup "$BACKUP_NAME")

log "Restoring $BACKUP_TYPE backup: $BACKUP_NAME"
if [ "$BACKUP_TYPE" = "incremental" ] && [ "$BASE_BACKUP" != "none" ]; then
    log "Base backup required: $BASE_BACKUP"
fi
log "WARNING: This will replace existing data in the logs database."
echo ""
echo "Press Ctrl+C within 5 seconds to abort..."
sleep 5

# If incremental, restore the base first
if [ "$BACKUP_TYPE" = "incremental" ] && [ "$BASE_BACKUP" != "none" ]; then
    log "Step 1/2: Restoring base backup: $BASE_BACKUP"
    if ! ensure_local "$BASE_BACKUP"; then
        log "ERROR: Cannot restore incremental without base backup"
        exit 1
    fi
    if ch_query "RESTORE DATABASE logs FROM Disk('local_backups', '$BASE_BACKUP') SETTINGS allow_non_empty_tables=true"; then
        log "Base backup restored successfully"
    else
        log "ERROR: Base backup restore failed"
        exit 1
    fi
    log "Step 2/2: Restoring incremental: $BACKUP_NAME"
else
    log "Restoring: $BACKUP_NAME"
fi

if ch_query "RESTORE DATABASE logs FROM Disk('local_backups', '$BACKUP_NAME') SETTINGS allow_non_empty_tables=true"; then
    log "Restore completed successfully from: $BACKUP_NAME"
else
    log "ERROR: Restore failed"
    exit 1
fi

# Verify
log "Verifying restore..."
ROW_COUNT=$(ch_query "SELECT count() FROM logs.events")
TABLE_COUNT=$(ch_query "SELECT count() FROM system.tables WHERE database = 'logs'")
log "Verification: $TABLE_COUNT tables, $ROW_COUNT events in logs.events"
log "Restore complete."
