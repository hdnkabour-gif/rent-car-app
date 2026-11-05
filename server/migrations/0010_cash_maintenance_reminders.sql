-- 0010_cash_maintenance_reminders (slice 5). Additive only.
--  * expenses: append-only, corrected by reversal (like payments);
--  * cash closing: one closing per branch and day, immutable; cash, cheques and cards apart (BR-12);
--  * maintenance by kilometres and/or months (BR-15, BR-16), done by an external garage;
--  * WhatsApp reminders: a wa.me link is prepared, the employee checks and sends it himself (D-016);
--    the log records only that a person confirmed sending it.

INSERT INTO permissions (code, description, grantable) VALUES
  ('expenses.record', 'Record expenses (fuel, washing, repairs, office…)', false),
  ('cash.read',       'See the cash of the day and closings of their branches', false),
  ('cash.close',      'Close the cash of the day (count and sign off)', true),
  ('reports.read',    'See business reports and export them', true),
  ('reminders.send',  'Prepare WhatsApp reminders and confirm they were sent', false);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager', 'expenses.record'), ('manager', 'cash.read'), ('manager', 'cash.close'), ('manager', 'reports.read'), ('manager', 'reminders.send'),
  ('employee', 'expenses.record'), ('employee', 'cash.read'), ('employee', 'reminders.send');

-- Expenses -------------------------------------------------------------------------------------
CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  kind            text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'reversal')),
  category        text NOT NULL CHECK (category IN ('fuel', 'washing', 'maintenance', 'repair', 'tyres', 'insurance', 'tax',
                                                   'parking', 'rent', 'salary', 'office', 'other')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  method          text NOT NULL CHECK (method IN ('cash', 'transfer', 'cheque', 'card')),
  spent_on        date NOT NULL,
  supplier        text CHECK (length(supplier) <= 120),
  reference       text CHECK (length(reference) <= 80),
  notes           text CHECK (length(notes) <= 1000),
  receipt_file_id uuid REFERENCES stored_files(id) ON DELETE RESTRICT,
  reverses_id     uuid UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  reason          text CHECK (length(reason) <= 500),
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK (kind <> 'reversal' OR reason IS NOT NULL)
);
CREATE INDEX expenses_branch_day_idx ON expenses (branch_id, spent_on);
CREATE INDEX expenses_vehicle_idx ON expenses (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE TRIGGER expenses_append_only BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Cash closing ---------------------------------------------------------------------------------
CREATE TABLE cash_closings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  business_date       date NOT NULL,
  expected_cash_cents bigint NOT NULL,          -- cash in − cash out of the day, from the ledgers
  counted_cash_cents  bigint NOT NULL CHECK (counted_cash_cents >= 0),
  difference_cents    bigint NOT NULL,
  totals              jsonb NOT NULL,           -- frozen copy of the day: per method and kind
  notes               text CHECK (length(notes) <= 1000),
  closed_by           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, business_date),
  CHECK (difference_cents = counted_cash_cents - expected_cash_cents),
  CHECK (difference_cents = 0 OR notes IS NOT NULL)
);
CREATE TRIGGER cash_closings_append_only BEFORE UPDATE OR DELETE ON cash_closings FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER cash_closings_no_truncate BEFORE TRUNCATE ON cash_closings FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Maintenance ----------------------------------------------------------------------------------
CREATE TABLE maintenance_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  item            text NOT NULL CHECK (item IN ('oil_change', 'oil_filter', 'air_filter', 'fuel_filter', 'tyres', 'brakes',
                                               'timing_belt', 'battery', 'air_conditioning', 'general_service', 'other')),
  label           text CHECK (length(label) <= 80),               -- for "other"
  interval_km     integer CHECK (interval_km BETWEEN 100 AND 500000),
  interval_months smallint CHECK (interval_months BETWEEN 1 AND 120),
  last_done_km    integer CHECK (last_done_km >= 0),
  last_done_on    date,
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (interval_km IS NOT NULL OR interval_months IS NOT NULL),
  CHECK (item <> 'other' OR label IS NOT NULL)
);
CREATE UNIQUE INDEX maintenance_plans_vehicle_item_key ON maintenance_plans (vehicle_id, item, coalesce(label, '')) WHERE archived_at IS NULL;
CREATE TRIGGER maintenance_plans_no_delete BEFORE DELETE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER maintenance_plans_no_truncate BEFORE TRUNCATE ON maintenance_plans FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

CREATE TABLE maintenance_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  plan_id         uuid REFERENCES maintenance_plans(id) ON DELETE RESTRICT,
  item            text NOT NULL,
  label           text CHECK (length(label) <= 80),
  done_on         date NOT NULL,
  km              integer NOT NULL CHECK (km >= 0),
  garage          text CHECK (length(garage) <= 120),
  cost_cents      bigint CHECK (cost_cents >= 0),
  expense_id      uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  invoice_file_id uuid REFERENCES stored_files(id) ON DELETE RESTRICT,
  notes           text CHECK (length(notes) <= 1000),
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_records_vehicle_idx ON maintenance_records (vehicle_id, done_on DESC);
CREATE TRIGGER maintenance_records_append_only BEFORE UPDATE OR DELETE ON maintenance_records FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER maintenance_records_no_truncate BEFORE TRUNCATE ON maintenance_records FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- WhatsApp reminders (manual sending) ----------------------------------------------------------
CREATE TABLE reminder_log (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('pickup', 'return', 'customer_document')),
  ref_id      uuid NOT NULL,          -- reservation, contract or customer
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sent_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminder_log_ref_idx ON reminder_log (kind, ref_id);
CREATE TRIGGER reminder_log_append_only BEFORE UPDATE OR DELETE ON reminder_log FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER reminder_log_no_truncate BEFORE TRUNCATE ON reminder_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
