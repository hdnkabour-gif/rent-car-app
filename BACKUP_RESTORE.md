# Backup and Restore

## Backup scope
A recovery set includes PostgreSQL data, private uploaded files, storage metadata/configuration, migration version and required non-secret configuration. Secrets belong only in an approved secure secret-management process, never repository archives.

## Policy to agree before production
Automated encrypted database backups; file/object storage backup or versioning; retention schedule and off-site copy; restricted administrator access; monitoring and failure alerts; agreed recovery point objective (RPO) and recovery time objective (RTO).

## Restore procedure
1. Declare recovery and stop writes if needed.
2. Provision a clean, access-restricted environment.
3. Restore database and matching file backup.
4. Apply only migrations appropriate to the restored version.
5. Verify record counts, file checksums/availability and key rental/finance workflows.
6. Re-enable access only after validation and record the recovery event.

Perform restore drills before production and periodically. Backup completion without a successful restore test is not sufficient evidence of recoverability.