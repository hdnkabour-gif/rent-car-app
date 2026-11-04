#!/usr/bin/env sh
# Fleetora — nightly verified backup (Linux host). Example crontab line (02:30 every night):
#   30 2 * * * /opt/fleetora/ops/backup-nightly.sh
# DATABASE_URL, STORAGE_DIR, BACKUP_DIR and BACKUP_PASSPHRASE come from /etc/fleetora/backup.env
# (mode 600, owned by the backup user) — never from this repository.
set -eu
. /etc/fleetora/backup.env
cd "$(dirname "$0")/.."
started=$(date -Iseconds)
set +e
node server/dist/src/scripts/backup.js >>"$BACKUP_DIR/backup-log.txt" 2>&1
code=$?
set -e
echo "[$started] exit code $code (0 = OK, 2 = saved with problems, 1 = failed)" >>"$BACKUP_DIR/backup-log.txt"
exit $code
