#!/bin/bash
set -e

BACKUP_CRON="${BACKUP_CRON:-0 3,15 * * *}"

# Persist Docker env vars so cron jobs can access them
env | grep -E '^(CLICKHOUSE_|BACKUP_)' > /etc/environment.docker

# Write crontab (Alpine uses direct crontab format)
echo "$BACKUP_CRON . /etc/environment.docker; /scripts/backup.sh >> /proc/1/fd/1 2>&1" | crontab -

echo "[$(date -Iseconds)] Backup scheduler started. Schedule: $BACKUP_CRON"
echo "[$(date -Iseconds)] Manual backup: docker compose exec backup /scripts/backup.sh"
echo "[$(date -Iseconds)] Restore:       docker compose exec backup /scripts/restore.sh"

exec crond -f -l 2
