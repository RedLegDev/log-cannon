#!/bin/bash
set -euo pipefail

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-clickhouse}"
BACKUP_RETAIN_LOCAL="${BACKUP_RETAIN_LOCAL:-7}"
BACKUP_RETAIN_OFFSITE="${BACKUP_RETAIN_OFFSITE:-14}"
BACKUP_DIR="/backups"
R2_BUCKET="${R2_BUCKET:-log-cannon-backups}"

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

# Upload to Cloudflare R2
if rclone --config /root/.config/rclone/rclone.conf listremotes 2>/dev/null | grep -q "r2:"; then
    log "Uploading backup to R2: ${R2_BUCKET}/${BACKUP_NAME}/"
    if rclone sync "$BACKUP_DIR/$BACKUP_NAME/" "r2:${R2_BUCKET}/${BACKUP_NAME}/" \
        --config /root/.config/rclone/rclone.conf \
        --transfers 8 \
        --checkers 4 \
        --s3-upload-concurrency 4; then
        log "R2 upload completed: ${R2_BUCKET}/${BACKUP_NAME}/"
    else
        log "WARNING: R2 upload failed. Local backup is still intact."
    fi
else
    log "WARNING: R2 not configured. Skipping offsite upload."
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

# Prune old R2 backups
if rclone --config /root/.config/rclone/rclone.conf listremotes 2>/dev/null | grep -q "r2:"; then
    R2_DIRS=$(rclone lsd "r2:${R2_BUCKET}/" --config /root/.config/rclone/rclone.conf 2>/dev/null | awk '{print $NF}' | grep "^logs-" | sort)
    R2_COUNT=$(echo "$R2_DIRS" | grep -c "^logs-" || true)
    if [ "$R2_COUNT" -gt "$BACKUP_RETAIN_OFFSITE" ]; then
        PRUNE_COUNT=$((R2_COUNT - BACKUP_RETAIN_OFFSITE))
        log "Pruning $PRUNE_COUNT old R2 backup(s) (keeping $BACKUP_RETAIN_OFFSITE)..."
        echo "$R2_DIRS" | head -n "$PRUNE_COUNT" | while read -r dir; do
            log "  Removing R2: $dir"
            rclone purge "r2:${R2_BUCKET}/${dir}" --config /root/.config/rclone/rclone.conf 2>/dev/null || true
        done
    fi
fi

log "Backup complete: $BACKUP_NAME"
