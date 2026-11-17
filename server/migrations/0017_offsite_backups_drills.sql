-- 0017_offsite_backups_drills (issue #14). Additive only: nothing is changed or removed.
-- 1. Each backup run records whether its ENCRYPTED copy reached the off-site target (external disk /
--    private S3-compatible bucket) and was checked there. No path, bucket credentials or secret is stored.
-- 2. Each restore drill (off-site copy -> fresh isolated database -> every SHA-256 checked) is recorded,
--    so the manager sees when recoverability was last PROVEN, not only when a backup was written.

ALTER TABLE backup_runs
  ADD COLUMN offsite_kind    text CHECK (offsite_kind IN ('dir', 's3')),
  ADD COLUMN offsite_ok      boolean,
  ADD COLUMN offsite_objects integer CHECK (offsite_objects >= 0),
  ADD COLUMN offsite_bytes   bigint CHECK (offsite_bytes >= 0),
  ADD COLUMN offsite_message text CHECK (length(offsite_message) <= 1000);

CREATE TABLE backup_drills (
  id                     bigserial PRIMARY KEY,
  started_at             timestamptz NOT NULL,
  finished_at            timestamptz NOT NULL DEFAULT now(),
  ok                     boolean NOT NULL,
  source                 text NOT NULL CHECK (source IN ('offsite', 'local')),
  offsite_kind           text CHECK (offsite_kind IN ('dir', 's3')),
  backup_name            text CHECK (length(backup_name) <= 200),   -- folder name only, never a path
  tables                 integer,
  rows_total             bigint,
  files_verified         integer,
  negative_checks_passed integer,
  negative_checks_total  integer,
  message                text CHECK (length(message) <= 1000)
);
CREATE TRIGGER backup_drills_append_only BEFORE UPDATE OR DELETE ON backup_drills FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER backup_drills_no_truncate BEFORE TRUNCATE ON backup_drills FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
