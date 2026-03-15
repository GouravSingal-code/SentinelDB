#!/bin/bash
set -e

# Runs automatically on first boot via /docker-entrypoint-initdb.d/
# Creates the streaming replication user so postgres-replica can connect.
# REPLICATOR_PASSWORD is passed as an env var from the compose spec.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v repl_pass="$REPLICATOR_PASSWORD" <<-EOSQL
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'repl_pass';
  GRANT pg_checkpoint TO ${POSTGRES_USER};
EOSQL

# Allow replication connections from any IP inside the cluster
# (postgres is x-omnistrate-mode-internal — not reachable from the internet)
echo "host replication replicator all md5" >> "$PGDATA/pg_hba.conf"

echo "[primary] Replication user created and pg_hba.conf updated."

# ── PITR: enable WAL archiving if S3 is configured ──────────────────────────
# archive_mode requires a restart to take effect. Since the official postgres
# image restarts after running initdb scripts, this will be active on the real start.
if [ -n "$WALG_S3_PREFIX" ]; then
  cat >> "$PGDATA/postgresql.conf" <<-EOF

# WAL archiving for PITR (configured by init-replication.sh)
archive_mode = on
archive_command = '/usr/local/bin/wal-archive.sh %p'
archive_timeout = ${ARCHIVE_TIMEOUT:-60}
EOF
  echo "[primary] WAL archiving enabled — archiving to $WALG_S3_PREFIX"
else
  echo "[primary] WALG_S3_PREFIX not set — WAL archiving skipped"
fi
