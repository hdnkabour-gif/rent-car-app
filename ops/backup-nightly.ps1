# Fleetora — nightly verified backup on the company host (Windows).
# Schedule with Task Scheduler (daily, e.g. 02:30, "Run whether user is logged on or not"):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\fleetora\ops\backup-nightly.ps1
# Secrets come from machine environment variables set by the administrator, never from this file:
#   DATABASE_URL, STORAGE_DIR, BACKUP_DIR (another disk), BACKUP_PASSPHRASE (12+ characters, stored
#   in the company password manager as well — without it the backups cannot be read), BACKUP_KEY_LABEL,
#   and the off-site copy: OFFSITE_KIND=dir + OFFSITE_DIR (external disk) or OFFSITE_KIND=s3 + OFFSITE_S3_*.
# Also schedule (see BACKUP_RESTORE.md, issue #14): weekly prune-backups.js (dry run first) and a monthly
#   backup-drill.js with DRILL_ADMIN_DATABASE_URL pointing at the maintenance database (never the app DB).
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:BACKUP_DIR 'backup-log.txt'
Set-Location $app
$started = Get-Date -Format s
node server/dist/src/scripts/backup.js *>> $log
$code = $LASTEXITCODE
Add-Content $log "[$started] exit code $code (0 = OK, 2 = saved with problems, 3 = off-site copy FAILED, 1 = failed)"
# The result is also recorded in the app: the manager sees a failed or missing backup on the home screen.
exit $code
