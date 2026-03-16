FROM clickhouse/clickhouse-client:latest

RUN apt-get update && apt-get install -y --no-install-recommends cron rsync && rm -rf /var/lib/apt/lists/*

COPY backup.sh restore.sh /scripts/
RUN chmod +x /scripts/*.sh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
