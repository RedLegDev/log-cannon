#!/bin/bash
set -euo pipefail

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-clickhouse}"
BACKUP_RETAIN_LOCAL="${BACKUP_RETAIN_LOCAL:-7}"
BACKUP_RETAIN_OFFSITE="${BACKUP_RETAIN_OFFSITE:-30}"
BACKUP_DIR="/backups"
GDRIVE_DIR="/gdrive/log-cannon-backups"

BACKUP_NAME="logs-$(date +%Y-%m-%d-%H%M%S)"

ch_query() {
    curl -sf "http://${CLICKHOUSE_HOST}:8123/" --data-binary "$1"
}

log() {
    echo "[$(date -Iseconds)] $1"
}

log "Starting backup: $BACKUP_NAME"

# Run ClickHouse native backup
if ch_query "BACKUP DATABASE logs TO Disk('local_backups', '$BACKUP_NAME')"; then
    log "ClickHouse backup completed successfully"
else
    log "ERROR: ClickHouse backup failed"
    exit 1
fi

# Sync to Google Drive
if [ -d "/gdrive" ]; then
    mkdir -p "$GDRIVE_DIR"
    log "Syncing backup to Google Drive..."
    if rsync -a "$BACKUP_DIR/$BACKUP_NAME/" "$GDRIVE_DIR/$BACKUP_NAME/"; then
        log "Offsite sync completed: $GDRIVE_DIR/$BACKUP_NAME"
    else
        log "WARNING: Offsite sync failed. Local backup is still intact."
    fi
else
    log "WARNING: Google Drive mount not available at /gdrive. Skipping offsite sync."
fi

# Prune old local backups
LOCAL_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name "logs-*" | wc -l)
if [ "$LOCAL_COUNT" -gt "$BACKUP_RETAIN_LOCAL" ]; then
    PRUNE_COUNT=$((LOCAL_COUNT - BACKUP_RETAIN_LOCAL))
    log "Pruning $PRUNE_COUNT old local backup(s) (keeping $BACKUP_RETAIN_LOCAL)..."
    find "$BACKUP_DIR" -maxdepth 1 -type d -name "logs-*" | sort | head -n "$PRUNE_COUNT" | while read -r dir; do
        log "  Removing local: $(basename "$dir")"
        rm -rf "$dir"
    done
fi

# Prune old offsite backups
if [ -d "$GDRIVE_DIR" ]; then
    OFFSITE_COUNT=$(find "$GDRIVE_DIR" -maxdepth 1 -type d -name "logs-*" | wc -l)
    if [ "$OFFSITE_COUNT" -gt "$BACKUP_RETAIN_OFFSITE" ]; then
        PRUNE_COUNT=$((OFFSITE_COUNT - BACKUP_RETAIN_OFFSITE))
        log "Pruning $PRUNE_COUNT old offsite backup(s) (keeping $BACKUP_RETAIN_OFFSITE)..."
        find "$GDRIVE_DIR" -maxdepth 1 -type d -name "logs-*" | sort | head -n "$PRUNE_COUNT" | while read -r dir; do
            log "  Removing offsite: $(basename "$dir")"
            rm -rf "$dir"
        done
    fi
fi

log "Backup complete: $BACKUP_NAME"
