FROM alpine:latest

RUN apk add --no-cache bash curl rclone

COPY backup.sh restore.sh /scripts/
RUN chmod +x /scripts/*.sh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
