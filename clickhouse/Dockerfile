FROM clickhouse/clickhouse-server:latest

COPY init/*.sql /docker-entrypoint-initdb.d/
COPY config/*.xml /etc/clickhouse-server/config.d/
