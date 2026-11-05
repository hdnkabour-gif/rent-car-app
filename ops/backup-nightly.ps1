# Fleetora — nightly verified backup on the company host (Windows).
# Schedule with Task Scheduler (daily, e.g. 02:30, "Run whether user is logged on or not"):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\fleetora\ops\backup-nightly.ps1
# Secrets come from machine environment variables set by the administrator, never from this file:
#   DATABASE_URL, STORAGE_DIR, BACKUP_DIR (another disk), BACKUP_PASSPHRASE (12+ characters, stored
#   in the company password manager as well — without it the backups cannot be read).
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:BACKUP_DIR 'backup-log.txt'
Set-Location $app
$started = Get-Date -Format s
node server/dist/src/scripts/backup.js *>> $log
$code = $LASTEXITCODE
Add-Content $log "[$started] exit code $code (0 = OK, 2 = saved with problems, 1 = failed)"
# The result is also recorded in the app: the manager sees a failed or missing backup on the home screen.
exit $code
