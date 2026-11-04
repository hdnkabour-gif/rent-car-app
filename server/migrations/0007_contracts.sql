-- 0007_contracts: the rental contract (check-out → check-in), modelled on the company's paper
-- contract, which stays the official signed document (D-015). Each company edits its own contract
-- template and general conditions; every saved template is a new immutable version and each
-- contract keeps the version it was printed with. Money movements go to an append-only ledger
-- where deposits are never revenue (CLAUDE.md, BR-12, BR-13). Additive only.

-- Company identity printed on the contract -------------------------------------------------------
ALTER TABLE company_settings ADD COLUMN phone2 text CHECK (length(phone2) <= 30);
ALTER TABLE company_settings ADD COLUMN logo_file_id uuid REFERENCES stored_files(id) ON DELETE RESTRICT;
-- Driver rules (owner answers 2026-11-04): minimum age, "new licence" warning, contract length.
ALTER TABLE company_settings ADD COLUMN min_driver_age smallint NOT NULL DEFAULT 18 CHECK (min_driver_age BETWEEN 16 AND 99);
ALTER TABLE company_settings ADD COLUMN new_licence_years smallint NOT NULL DEFAULT 2 CHECK (new_licence_years BETWEEN 0 AND 10);
ALTER TABLE company_settings ADD COLUMN max_contract_days smallint NOT NULL DEFAULT 30 CHECK (max_contract_days BETWEEN 1 AND 366);
-- A return later than this after the planned time proposes extra day(s); the manager decides (BR-05).
ALTER TABLE company_settings ADD COLUMN late_grace_minutes smallint NOT NULL DEFAULT 60 CHECK (late_grace_minutes BETWEEN 0 AND 1440);

-- Fields printed on the paper contract that customers did not have yet.
ALTER TABLE customers ADD COLUMN profession text CHECK (length(profession) <= 120);
ALTER TABLE customers ADD COLUMN other_address text CHECK (length(other_address) <= 300);
ALTER TABLE customers ADD COLUMN id_doc_issue_date date;

INSERT INTO permissions (code, description, grantable) VALUES
  ('contracts.read',        'See rental contracts and their payments', false),
  ('contracts.manage',      'Hand over a vehicle (check-out), take it back (check-in), extend a rental', false),
  ('contracts.templates',   'Edit the contract template and general conditions', true),
  ('payments.record',       'Record payments and deposits received', false),
  ('payments.reverse',      'Correct a payment by a reversal entry (with reason)', true),
  ('deposits.refund',       'Give back a deposit', true),
  ('deposits.retain',       'Keep all or part of a deposit (damage, fuel, late return), with reason', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager',  'contracts.read'), ('manager', 'contracts.manage'), ('manager', 'contracts.templates'),
  ('manager',  'payments.record'), ('manager', 'payments.reverse'), ('manager', 'deposits.refund'), ('manager', 'deposits.retain'),
  ('employee', 'contracts.read'), ('employee', 'contracts.manage'), ('employee', 'payments.record');

-- Contract templates (versioned, immutable) ------------------------------------------------------
CREATE TABLE contract_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version               integer NOT NULL UNIQUE CHECK (version >= 1),
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  handed_documents      text[] NOT NULL CHECK (cardinality(handed_documents) <= 20),
  responsibility_clause text CHECK (length(responsibility_clause) <= 1000),
  terms_title           text NOT NULL CHECK (length(terms_title) BETWEEN 1 AND 120),
  terms                 jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'array' AND jsonb_array_length(terms) <= 60),
  terms_ar              jsonb CHECK (terms_ar IS NULL OR (jsonb_typeof(terms_ar) = 'array' AND jsonb_array_length(terms_ar) <= 60)),
  show_vehicle_diagram  boolean NOT NULL DEFAULT true,
  second_driver_section boolean NOT NULL DEFAULT true,
  notes                 text CHECK (length(notes) <= 500),      -- why this version was made
  created_by            uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER contract_templates_append_only BEFORE UPDATE OR DELETE ON contract_templates FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER contract_templates_no_truncate BEFORE TRUNCATE ON contract_templates FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Neutral starting template (no company-specific wording): the manager adapts it.
INSERT INTO contract_templates (version, title, handed_documents, responsibility_clause, terms_title, terms, notes) VALUES (
  1,
  'CONTRAT DE LOCATION',
  ARRAY['Carte grise', 'Assurance', 'Vignette', 'Visite technique', 'Autorisation', 'Contrat'],
  'Le conducteur est responsable du véhicule en cas d''accident.',
  'CONDITIONS GÉNÉRALES',
  '[{"title": "Article 1 — Objet", "body": "À compléter par la société : conditions générales de location."}]'::jsonb,
  'Modèle de départ, à adapter par le gérant'
);

-- Contracts --------------------------------------------------------------------------------------
CREATE SEQUENCE contract_number_seq;

CREATE TABLE contracts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              bigint NOT NULL UNIQUE DEFAULT nextval('contract_number_seq'),
  paper_number        text CHECK (length(btrim(paper_number)) BETWEEN 1 AND 30),  -- pre-printed N° of the signed paper
  reservation_id      uuid NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id          uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  return_branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  template_id         uuid NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- departure
  out_at              timestamptz NOT NULL,
  planned_end_at      timestamptz NOT NULL,
  km_out              integer NOT NULL CHECK (km_out >= 0),
  fuel_out            smallint NOT NULL CHECK (fuel_out BETWEEN 0 AND 8),
  washed_out          boolean,
  documents_out       text[] NOT NULL DEFAULT '{}',
  notes_out           text CHECK (length(notes_out) <= 2000),
  out_by              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- price (agreed per day; days grow with extensions and charged late days)
  daily_cents         integer NOT NULL CHECK (daily_cents >= 0),
  days                integer NOT NULL CHECK (days BETWEEN 1 AND 366),
  extra_days          integer NOT NULL DEFAULT 0 CHECK (extra_days BETWEEN 0 AND 366),
  extra_days_reason   text CHECK (length(extra_days_reason) <= 500),
  total_cents         bigint NOT NULL CHECK (total_cents >= 0),
  deposit_cents       integer NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),   -- agreed deposit
  -- return
  in_at               timestamptz,
  km_in               integer CHECK (km_in >= 0),
  fuel_in             smallint CHECK (fuel_in BETWEEN 0 AND 8),
  notes_in            text CHECK (length(notes_in) <= 2000),
  in_by               uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- frozen copy of what was printed (customer, vehicle, company), so later edits never change it
  snapshot            jsonb NOT NULL,
  signed_scan_file_id uuid REFERENCES stored_files(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end_at > out_at),
  CHECK (total_cents = (days + extra_days)::bigint * daily_cents),
  CHECK ((status = 'closed') = (in_at IS NOT NULL)),
  CHECK (in_at IS NULL OR (km_in IS NOT NULL AND fuel_in IS NOT NULL AND in_by IS NOT NULL)),
  CHECK (km_in IS NULL OR km_in >= km_out)
);
CREATE UNIQUE INDEX contracts_paper_number_key ON contracts (upper(btrim(paper_number))) WHERE paper_number IS NOT NULL;
CREATE INDEX contracts_customer_idx ON contracts (customer_id, out_at DESC);
CREATE INDEX contracts_vehicle_idx ON contracts (vehicle_id, out_at DESC);
CREATE INDEX contracts_branch_idx ON contracts (branch_id, status);
CREATE TRIGGER contracts_no_delete BEFORE DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER contracts_no_truncate BEFORE TRUNCATE ON contracts FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Additional driver(s) on a contract (F-025).
CREATE TABLE contract_drivers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  full_name          text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  licence_number     text CHECK (length(licence_number) <= 40),
  licence_issue_date date,
  licence_issue_place text CHECK (length(licence_issue_place) <= 100),
  id_number          text CHECK (length(id_number) <= 40),
  id_issue_date      date,
  phone              text CHECK (length(phone) <= 40),
  created_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_drivers_contract_idx ON contract_drivers (contract_id);
CREATE TRIGGER contract_drivers_no_delete BEFORE DELETE ON contract_drivers FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER contract_drivers_no_truncate BEFORE TRUNCATE ON contract_drivers FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Photos at departure and return (BR-07).
CREATE TABLE contract_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  phase       text NOT NULL CHECK (phase IN ('out', 'in')),
  file_id     uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, phase, file_id)
);
CREATE TRIGGER contract_photos_append_only BEFORE UPDATE OR DELETE ON contract_photos FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER contract_photos_no_truncate BEFORE TRUNCATE ON contract_photos FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Contract history (append-only).
CREATE TABLE contract_events (
  id            bigserial PRIMARY KEY,
  contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  event         text NOT NULL CHECK (event IN ('checked_out', 'extended', 'checked_in', 'payment', 'paper_number', 'signed_scan', 'driver_added')),
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason        text CHECK (length(reason) <= 500),
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_events_contract_idx ON contract_events (contract_id, id);
CREATE TRIGGER contract_events_append_only BEFORE UPDATE OR DELETE ON contract_events FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER contract_events_no_truncate BEFORE TRUNCATE ON contract_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Money ledger (append-only; a mistake is corrected by a reversal entry, never edited) ------------
-- kind: rental      = payment of the rental price (revenue)
--       deposit_in  = deposit received (NOT revenue; cash, cheque or card hold are separate instruments)
--       deposit_out = deposit given back
--       deposit_kept= deposit kept for damage/fuel/late return (decided by an authorized person)
--       reversal    = cancels one earlier entry (same amount, opposite effect)
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('rental', 'deposit_in', 'deposit_out', 'deposit_kept', 'reversal')),
  method        text NOT NULL CHECK (method IN ('cash', 'transfer', 'cheque', 'card')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  reference     text CHECK (length(reference) <= 80),     -- cheque N°, transfer reference, card slip
  reason        text CHECK (length(reason) <= 500),
  reverses_id   uuid UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK (kind NOT IN ('reversal', 'deposit_kept') OR reason IS NOT NULL),
  -- payments of the rental are cash or bank transfer (BR-13); deposits cash, cheque or card (BR-12)
  CHECK (kind <> 'rental' OR method IN ('cash', 'transfer')),
  CHECK (kind NOT IN ('deposit_in', 'deposit_out') OR method IN ('cash', 'cheque', 'card', 'transfer'))
);
CREATE INDEX payments_contract_idx ON payments (contract_id, created_at);
CREATE INDEX payments_branch_day_idx ON payments (branch_id, created_at);
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
