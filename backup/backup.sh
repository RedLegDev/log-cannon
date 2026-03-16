#!/bin/bash
set -euo pipefail

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-clickhouse}"
BACKUP_RETAIN_LOCAL="${BACKUP_RETAIN_LOCAL:-7}"
BACKUP_RETAIN_OFFSITE="${BACKUP_RETAIN_OFFSITE:-14}"
BACKUP_FULL_SCHEDULE="${BACKUP_FULL_SCHEDULE:-0}"
BACKUP_DIR="/backups"
R2_BUCKET="${R2_BUCKET:-log-cannon-backups}"
RCLONE_CONF="/root/.config/rclone/rclone.conf"

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)

ch_query() {
    curl -sf "http://${CLICKHOUSE_HOST}:8123/" --data-binary "$1"
}

log() {
    echo "[$(date -Iseconds)] $1"
}

has_r2() {
    rclone --config "$RCLONE_CONF" listremotes 2>/dev/null | grep -q "r2:"
}

# Find the latest full backup (local filesystem)
find_latest_full() {
    # Check new naming convention first, then legacy
    local latest=""
    latest=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name "logs-full-*" 2>/dev/null | sort -r | head -1 | xargs -r basename)
    if [ -z "$latest" ]; then
        # Legacy backups (logs-YYYY-MM-DD-*) treated as full
        latest=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name "logs-[0-9]*" 2>/dev/null | sort -r | head -1 | xargs -r basename)
    fi
    echo "$latest"
}

# Determine backup type
determine_backup_type() {
    local day_of_week
    day_of_week=$(date +%w)
    local latest_full
    latest_full=$(find_latest_full)

    # Force full if: no full exists, or today matches full schedule
    if [ -z "$latest_full" ]; then
        log "No existing full backup found — forcing full backup"
        echo "full"
    elif [ "$day_of_week" = "$BACKUP_FULL_SCHEDULE" ]; then
        # Check if we already did a full today
        local today
        today=$(date +%Y-%m-%d)
        if echo "$latest_full" | grep -q "logs-full-${today}"; then
            echo "incremental"
        else
            log "Scheduled full backup day (day $BACKUP_FULL_SCHEDULE)"
            echo "full"
        fi
    else
        echo "incremental"
    fi
}

write_metadata() {
    local backup_name="$1"
    local backup_type="$2"
    local base_name="${3:-none}"
    cat > "$BACKUP_DIR/$backup_name/.backup_meta" <<EOF
type=$backup_type
base=$base_name
timestamp=$(date -Iseconds)
EOF
}

BACKUP_TYPE=$(determine_backup_type)

if [ "$BACKUP_TYPE" = "full" ]; then
    BACKUP_NAME="logs-full-${TIMESTAMP}"
    log "Starting FULL backup: $BACKUP_NAME"

    if ch_query "BACKUP DATABASE logs TO Disk('local_backups', '$BACKUP_NAME')"; then
        log "Full backup completed successfully"
        write_metadata "$BACKUP_NAME" "full"
    else
        log "ERROR: ClickHouse full backup failed"
        exit 1
    fi
else
    BASE_BACKUP=$(find_latest_full)
    BACKUP_NAME="logs-incr-${TIMESTAMP}"
    log "Starting INCREMENTAL backup: $BACKUP_NAME (base: $BASE_BACKUP)"

    if ch_query "BACKUP DATABASE logs TO Disk('local_backups', '$BACKUP_NAME') SETTINGS base_backup = Disk('local_backups', '$BASE_BACKUP')"; then
        log "Incremental backup completed successfully"
        write_metadata "$BACKUP_NAME" "incremental" "$BASE_BACKUP"
    else
        log "ERROR: ClickHouse incremental backup failed"
        exit 1
    fi
fi

# Upload to Cloudflare R2
if has_r2; then
    log "Uploading backup to R2: ${R2_BUCKET}/${BACKUP_NAME}/"
    if rclone sync "$BACKUP_DIR/$BACKUP_NAME/" "r2:${R2_BUCKET}/${BACKUP_NAME}/" \
        --config "$RCLONE_CONF" \
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

# --- Chain-aware retention pruning ---

# Collect all full backup names referenced by incrementals still within retention
collect_protected_fulls() {
    local source="$1"  # "local" or "r2"
    local protected=""

    if [ "$source" = "local" ]; then
        for meta in "$BACKUP_DIR"/logs-incr-*/.backup_meta 2>/dev/null; do
            [ -f "$meta" ] || continue
            local base
            base=$(grep "^base=" "$meta" | cut -d= -f2)
            [ "$base" != "none" ] && protected="$protected $base"
        done
    fi
    echo "$protected"
}

# Prune local backups (chain-aware)
log "Checking local retention (keeping $BACKUP_RETAIN_LOCAL)..."
LOCAL_BACKUPS=$(find "$BACKUP_DIR" -maxdepth 1 -type d \( -name "logs-full-*" -o -name "logs-incr-*" -o -name "logs-[0-9]*" \) 2>/dev/null | sort)
LOCAL_COUNT=$(echo "$LOCAL_BACKUPS" | grep -c "." || true)

if [ "$LOCAL_COUNT" -gt "$BACKUP_RETAIN_LOCAL" ]; then
    PROTECTED=$(collect_protected_fulls "local")
    PRUNE_COUNT=$((LOCAL_COUNT - BACKUP_RETAIN_LOCAL))
    log "Pruning up to $PRUNE_COUNT old local backup(s)..."
    PRUNED=0
    echo "$LOCAL_BACKUPS" | head -n "$PRUNE_COUNT" | while read -r dir; do
        local_name=$(basename "$dir")
        # Don't delete a full backup that's still referenced
        if echo "$PROTECTED" | grep -qw "$local_name"; then
            log "  Protecting $local_name (referenced by incremental)"
            continue
        fi
        log "  Removing local: $local_name"
        rm -rf "$dir"
    done
fi

# Prune R2 backups (chain-aware)
if has_r2; then
    R2_DIRS=$(rclone lsd "r2:${R2_BUCKET}/" --config "$RCLONE_CONF" 2>/dev/null | awk '{print $NF}' | grep "^logs-" | sort)
    R2_COUNT=$(echo "$R2_DIRS" | grep -c "^logs-" || true)

    if [ "$R2_COUNT" -gt "$BACKUP_RETAIN_OFFSITE" ]; then
        # For R2, we download metadata to check references
        # Simple approach: list all incr backups in R2, check their names against full candidates
        R2_INCR=$(echo "$R2_DIRS" | grep "^logs-incr-" || true)
        R2_PROTECTED=""
        # Incrementals within retention protect their base
        echo "$R2_DIRS" | tail -n "$BACKUP_RETAIN_OFFSITE" | grep "^logs-incr-" | while read -r incr_dir; do
            # Try to read metadata from R2
            meta=$(rclone cat "r2:${R2_BUCKET}/${incr_dir}/.backup_meta" --config "$RCLONE_CONF" 2>/dev/null || true)
            base=$(echo "$meta" | grep "^base=" | cut -d= -f2)
            [ -n "$base" ] && [ "$base" != "none" ] && R2_PROTECTED="$R2_PROTECTED $base"
        done

        PRUNE_COUNT=$((R2_COUNT - BACKUP_RETAIN_OFFSITE))
        log "Pruning up to $PRUNE_COUNT old R2 backup(s)..."
        echo "$R2_DIRS" | head -n "$PRUNE_COUNT" | while read -r dir; do
            if echo "$R2_PROTECTED" | grep -qw "$dir"; then
                log "  Protecting R2: $dir (referenced by incremental)"
                continue
            fi
            log "  Removing R2: $dir"
            rclone purge "r2:${R2_BUCKET}/${dir}" --config "$RCLONE_CONF" 2>/dev/null || true
        done
    fi
fi

log "Backup complete: $BACKUP_NAME ($BACKUP_TYPE)"
