-- 0009_audit_fixes (independent audit, 2026-11-05). Additive; no data removed.
--  1. Extending a rental is the manager's decision: its own permission `contracts.extend`
--     (delegable to a named employee), no longer part of `contracts.manage`.
--  2. The minimum driver age can never be set below 18 (owner rule).
--  3. Other drivers carry a birth date so their age is checked too.
--  4. Every backup run is recorded, so the manager sees a missing or failed backup.

INSERT INTO permissions (code, description, grantable) VALUES
  ('contracts.extend', 'Extend a rental (new return date)', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES ('manager', 'contracts.extend');
UPDATE permissions SET description = 'Hand over a vehicle (check-out) and take it back (check-in)' WHERE code = 'contracts.manage';

UPDATE company_settings SET min_driver_age = 18 WHERE min_driver_age < 18;
ALTER TABLE company_settings ADD CONSTRAINT company_settings_min_driver_age_18 CHECK (min_driver_age >= 18);

ALTER TABLE contract_drivers ADD COLUMN birth_date date CHECK (birth_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01');

CREATE TABLE backup_runs (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  ok           boolean NOT NULL,
  encrypted    boolean NOT NULL DEFAULT false,
  folder_name  text CHECK (length(folder_name) <= 200),     -- name only, never a full path
  tables       integer,
  rows_total   bigint,
  files        integer,
  problems     integer NOT NULL DEFAULT 0,
  message      text CHECK (length(message) <= 1000)
);
CREATE TRIGGER backup_runs_append_only BEFORE UPDATE OR DELETE ON backup_runs FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER backup_runs_no_truncate BEFORE TRUNCATE ON backup_runs FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
