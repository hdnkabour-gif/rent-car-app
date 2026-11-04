-- 0008_late_fees_licence (owner answers 2026-11-04):
--  * a licence younger than ONE year triggers the "new licence" warning;
--  * for a late return the MANAGER decides what is charged: whole days, half days or hours
--    (or nothing). The return itself can be done by an employee; the decision then waits for an
--    authorized person ("pending"). Additive; existing contracts keep their amounts.

ALTER TABLE company_settings ALTER COLUMN new_licence_years SET DEFAULT 1;
-- The previous default (2) was a placeholder, never an owner decision: apply the owner's rule.
UPDATE company_settings SET new_licence_years = 1 WHERE new_licence_years = 2;

ALTER TABLE contracts
  ADD COLUMN late_minutes     integer CHECK (late_minutes >= 0),
  ADD COLUMN late_status      text NOT NULL DEFAULT 'none' CHECK (late_status IN ('none', 'pending', 'charged', 'waived')),
  ADD COLUMN late_unit        text CHECK (late_unit IN ('day', 'half_day', 'hour')),
  ADD COLUMN late_quantity    integer CHECK (late_quantity BETWEEN 1 AND 1000),
  ADD COLUMN late_unit_cents  integer CHECK (late_unit_cents BETWEEN 0 AND 100000000),
  ADD COLUMN late_fee_cents   bigint NOT NULL DEFAULT 0 CHECK (late_fee_cents >= 0),
  ADD COLUMN late_reason      text CHECK (length(late_reason) <= 500),
  ADD COLUMN late_decided_by  uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN late_decided_at  timestamptz;

-- Contracts closed before this migration charged whole extra days: keep exactly that amount.
UPDATE contracts SET late_fee_cents = extra_days::bigint * daily_cents,
                     late_status = CASE WHEN extra_days > 0 THEN 'charged' ELSE 'none' END,
                     late_unit = CASE WHEN extra_days > 0 THEN 'day' END,
                     late_quantity = CASE WHEN extra_days > 0 THEN extra_days END,
                     late_unit_cents = CASE WHEN extra_days > 0 THEN daily_cents END,
                     late_reason = extra_days_reason;

-- Total = rental days × agreed price + late fee (replaces "(days + extra_days) × price").
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'contracts'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%extra_days%' AND pg_get_constraintdef(oid) LIKE '%total_cents%'
  LOOP
    EXECUTE format('ALTER TABLE contracts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'contract_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%checked_out%'
  LOOP
    EXECUTE format('ALTER TABLE contract_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END;
$$;
ALTER TABLE contracts ADD CONSTRAINT contracts_total_check CHECK (total_cents = days::bigint * daily_cents + late_fee_cents);
ALTER TABLE contracts ADD CONSTRAINT contracts_late_fee_check CHECK (
  (late_status = 'charged' AND late_unit IS NOT NULL AND late_quantity IS NOT NULL AND late_unit_cents IS NOT NULL
     AND late_fee_cents = late_quantity::bigint * late_unit_cents)
  OR (late_status <> 'charged' AND late_fee_cents = 0));
ALTER TABLE contracts ADD CONSTRAINT contracts_late_waive_reason CHECK (late_status <> 'waived' OR late_reason IS NOT NULL);
ALTER TABLE contract_events ADD CONSTRAINT contract_events_event_check CHECK (
  event IN ('checked_out', 'extended', 'checked_in', 'payment', 'paper_number', 'signed_scan', 'driver_added', 'late_fee'));
CREATE INDEX contracts_late_pending_idx ON contracts (branch_id) WHERE late_status = 'pending';
