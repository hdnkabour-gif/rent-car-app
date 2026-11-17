#!/usr/bin/env sh
# Fleetora — nightly verified backup (Linux host). Example crontab line (02:30 every night):
#   30 2 * * * /opt/fleetora/ops/backup-nightly.sh
# DATABASE_URL, STORAGE_DIR, BACKUP_DIR (another disk), BACKUP_PASSPHRASE, BACKUP_KEY_LABEL and the off-site
# settings (OFFSITE_KIND=dir + OFFSITE_DIR, or OFFSITE_KIND=s3 + OFFSITE_S3_*) come from /etc/fleetora/backup.env
# (mode 600, owned by the backup user) — never from this repository. See BACKUP_RESTORE.md (issue #14).
# Other lines for the same crontab (see BACKUP_RESTORE.md):
#   15 4 * * 0   cd /opt/fleetora && . /etc/fleetora/backup.env && node server/dist/src/scripts/prune-backups.js   (dry run; add --apply once checked)
#   30 5 1-7 * 1 cd /opt/fleetora && . /etc/fleetora/backup.env && DRILL_REPORT=/var/log/fleetora/drill-$(date +\%F).json node server/dist/src/scripts/backup-drill.js
set -eu
. /etc/fleetora/backup.env
cd "$(dirname "$0")/.."
started=$(date -Iseconds)
set +e
node server/dist/src/scripts/backup.js >>"$BACKUP_DIR/backup-log.txt" 2>&1
code=$?
set -e
echo "[$started] exit code $code (0 = OK, 2 = saved with problems, 3 = off-site copy FAILED, 1 = failed)" >>"$BACKUP_DIR/backup-log.txt"
exit $code
