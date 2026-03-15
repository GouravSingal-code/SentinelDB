#!/bin/sh
set -e

DATA_DIR="${PGDATA:-/var/lib/postgresql/data}"

# On first boot: copy the full primary data dir and configure standby mode.
# On subsequent boots: skip straight to starting the existing standby.
if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
  echo "[replica] Data dir empty — running pg_basebackup from $PRIMARY_HOST ..."

  # Wait until the primary is accepting connections
  until pg_isready -h "$PRIMARY_HOST" -U replicator > /dev/null 2>&1; do
    echo "[replica] Primary not ready yet, retrying in 3s..."
    sleep 3
  done

  PGPASSWORD="$REPLICATOR_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" \
    -U replicator \
    -D "$DATA_DIR" \
    -P -Xs -R \
    --checkpoint=fast

  chown -R postgres:postgres "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  echo "[replica] Base backup complete — starting standby."
else
  echo "[replica] Data dir exists — starting existing standby."
fi

exec docker-entrypoint.sh postgres \
  -c hot_standby=on \
  -c "max_connections=${MAX_CONNECTIONS:-75}"
