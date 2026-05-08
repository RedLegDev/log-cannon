#!/bin/bash
set -e

BACKUP_CRON="${BACKUP_CRON:-0 3,15 * * *}"

# Persist Docker env vars so cron jobs can access them.
# Quote values so entries with spaces (e.g. BACKUP_CRON="0 3,15 * * *") source cleanly.
env | grep -E '^(CLICKHOUSE_|BACKUP_|R2_)' \
    | sed -E 's/^([^=]+)=(.*)$/\1='\''\2'\''/' \
    > /etc/environment.docker

# Generate rclone config for Cloudflare R2 if credentials are present
if [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$R2_ACCOUNT_ID" ]; then
    mkdir -p /root/.config/rclone
    cat > /root/.config/rclone/rclone.conf <<RCLONE_EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
RCLONE_EOF
    echo "[$(date -Iseconds)] R2 offsite backup configured (bucket: ${R2_BUCKET:-log-cannon-backups})"
else
    echo "[$(date -Iseconds)] WARNING: R2 credentials not set. Offsite backups disabled."
    echo "[$(date -Iseconds)]   Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"
fi

# Write crontab (Alpine uses direct crontab format)
echo "$BACKUP_CRON . /etc/environment.docker; /scripts/backup.sh >> /proc/1/fd/1 2>&1" | crontab -

echo "[$(date -Iseconds)] Backup scheduler started. Schedule: $BACKUP_CRON"
echo "[$(date -Iseconds)] Manual backup: docker compose exec backup /scripts/backup.sh"
echo "[$(date -Iseconds)] Restore:       docker compose exec backup /scripts/restore.sh"

exec crond -f -l 2
