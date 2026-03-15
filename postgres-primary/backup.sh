#!/bin/bash
# Runs daily via cron. Takes a full base backup and pushes it to S3.
# WAL-G then knows which WAL segments belong to this backup for PITR.
#
# Restore procedure (run on a fresh postgres data dir):
#   wal-g backup-fetch $PGDATA LATEST
#   echo "restore_command = 'wal-g wal-fetch %f %p'" >> $PGDATA/postgresql.auto.conf
#   echo "recovery_target_time = '2024-01-15 14:30:00'" >> $PGDATA/postgresql.auto.conf
#   touch $PGDATA/recovery.signal
#   # Then start postgres — it will replay WAL up to recovery_target_time

set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

# WAL-G derives the PG user from the OS username, which may not exist as a PG role.
# Explicitly set libpq env vars so WAL-G connects as the app user.
export PGUSER="${POSTGRES_USER:-app}"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE="${POSTGRES_DB:-appdb}"

if [ -z "$WALG_S3_PREFIX" ]; then
  echo "[backup] WALG_S3_PREFIX not set — skipping"
  exit 0
fi

echo "[backup] Starting base backup at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
wal-g backup-push "$PGDATA"
echo "[backup] Base backup complete at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Retain the last N full backups (delete older ones + their WAL)
RETENTION="${WALG_BACKUP_RETENTION_FULL:-7}"
wal-g delete retain FULL "$RETENTION" --confirm
echo "[backup] Retention enforced — keeping last $RETENTION full backups"
