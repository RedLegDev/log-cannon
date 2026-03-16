#!/bin/bash
set -e

BACKUP_CRON="${BACKUP_CRON:-0 3,15 * * *}"

# Persist Docker env vars so cron jobs can access them
env | grep -E '^(CLICKHOUSE_|BACKUP_)' > /etc/environment.docker

echo "$BACKUP_CRON root . /etc/environment.docker; /scripts/backup.sh >> /proc/1/fd/1 2>&1" > /etc/cron.d/backup
chmod 0644 /etc/cron.d/backup
crontab /etc/cron.d/backup

echo "[$(date -Iseconds)] Backup scheduler started. Schedule: $BACKUP_CRON"
echo "[$(date -Iseconds)] Manual backup: docker compose exec backup /scripts/backup.sh"
echo "[$(date -Iseconds)] Restore:       docker compose exec backup /scripts/restore.sh"

exec cron -f
