#!/bin/bash
set -e

# If S3 is configured, start cron for scheduled base backups.
# Cron doesn't inherit container env vars, so we dump them to a file first.
if [ -n "$WALG_S3_PREFIX" ]; then
  echo "[primary] PITR enabled — S3 prefix: $WALG_S3_PREFIX"

  # Write env vars that backup.sh and wal-archive.sh need.
  # Use /tmp — always writable regardless of container user or root filesystem policy.
  printenv | grep -E '^(WALG_|AWS_|PGDATA=|PGUSER=|PGPASSWORD=|PGDATABASE=|POSTGRES_)' > /tmp/walg-env
  echo "PGDATA=${PGDATA:-/var/lib/postgresql/data}" >> /tmp/walg-env
  chmod 600 /tmp/walg-env

  # Write crontab file and start supercronic (works without a passwd entry for this UID)
  CRON_SCHEDULE="${BACKUP_CRON_SCHEDULE:-0 2 * * *}"
  echo "$CRON_SCHEDULE . /tmp/walg-env; /usr/local/bin/backup.sh >> /tmp/walg-backup.log 2>&1" > /tmp/walg-crontab
  supercronic /tmp/walg-crontab &
  echo "[primary] Supercronic started — base backup scheduled: $CRON_SCHEDULE"
else
  echo "[primary] WALG_S3_PREFIX not set — PITR disabled, WAL archiving skipped"
fi

# Hand off to the official postgres entrypoint
exec docker-entrypoint.sh "$@"
