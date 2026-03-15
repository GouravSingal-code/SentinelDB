#!/bin/bash
# Called by PostgreSQL as archive_command='wal-archive.sh %p'
# %p is replaced by postgres with the absolute path to the WAL segment file.
#
# Postgres requires archive_command to exit 0 on success and non-zero on failure.
# If non-zero, postgres retries — it never deletes a WAL segment until archiving succeeds.

set -e

WAL_PATH="$1"

if [ -z "$WALG_S3_PREFIX" ]; then
  # Should not happen — archive_mode is only enabled when WALG_S3_PREFIX is set.
  # Exit non-zero so postgres keeps the WAL file rather than silently dropping it.
  echo "[wal-archive] ERROR: WALG_S3_PREFIX is not set" >&2
  exit 1
fi

wal-g wal-push "$WAL_PATH"
