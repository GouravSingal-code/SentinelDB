FROM postgres:16-alpine

# Custom entrypoint: runs pg_basebackup on first boot, then starts Postgres in standby mode
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
