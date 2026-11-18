-- 0019: Infractions MVP. Records are entered manually from a lawfully obtained notice.
-- No NARSA integration, password, scraping, third-party API, financial charge, or automatic driver designation.
INSERT INTO permissions (code, description, grantable) VALUES
  ('infractions.read', 'Read road infractions of visible fleet vehicles', false),
  ('infractions.manage', 'Record and review road infractions, manual manager decisions', false);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager', 'infractions.read'),
  ('manager', 'infractions.manage');

CREATE TABLE road_infractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, -- historical branch at registration
  issuer text NOT NULL CHECK (length(btrim(issuer)) BETWEEN 2 AND 100),
  notice_number text NOT NULL CHECK (length(btrim(notice_number)) BETWEEN 2 AND 100),
  source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  occurred_at timestamptz NOT NULL,
  notified_on date,
  location text CHECK (length(location) <= 250),
  kind text CHECK (length(kind) <= 120),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'under_review', 'contested', 'paid', 'closed')),
  payment_reference text CHECK (length(payment_reference) <= 120),
  contract_id uuid REFERENCES contracts(id) ON DELETE RESTRICT,
  match_status text NOT NULL DEFAULT 'pending'
    CHECK (match_status IN ('pending', 'confirmed', 'no_contract')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  review_reason text CHECK (length(review_reason) BETWEEN 10 AND 500),
  notes text CHECK (length(notes) <= 500),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT road_infractions_notice_key UNIQUE (vehicle_id, issuer, notice_number),
  CONSTRAINT road_infractions_review_consistent CHECK (
    (match_status = 'pending' AND contract_id IS NULL AND reviewed_at IS NULL AND reviewed_by IS NULL AND review_reason IS NULL)
    OR
    (match_status = 'confirmed' AND contract_id IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_reason IS NOT NULL)
    OR
    (match_status = 'no_contract' AND contract_id IS NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_reason IS NOT NULL)
  ),
  CONSTRAINT road_infractions_payment_reference CHECK (status <> 'paid' OR payment_reference IS NOT NULL)
);
CREATE INDEX road_infractions_vehicle_date_idx ON road_infractions (vehicle_id, occurred_at DESC);
CREATE INDEX road_infractions_branch_status_idx ON road_infractions (branch_id, status, occurred_at DESC);
CREATE INDEX road_infractions_contract_idx ON road_infractions (contract_id) WHERE contract_id IS NOT NULL;
CREATE TRIGGER road_infractions_no_delete BEFORE DELETE ON road_infractions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER road_infractions_no_truncate BEFORE TRUNCATE ON road_infractions FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

CREATE TABLE road_infraction_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  infraction_id uuid NOT NULL REFERENCES road_infractions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('registered', 'match_reviewed', 'status_changed')),
  previous_status text,
  next_status text,
  previous_contract_id uuid REFERENCES contracts(id) ON DELETE RESTRICT,
  next_contract_id uuid REFERENCES contracts(id) ON DELETE RESTRICT,
  reason text CHECK (length(reason) <= 500),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX road_infraction_events_infraction_idx ON road_infraction_events (infraction_id, id);
CREATE TRIGGER road_infraction_events_append_only BEFORE UPDATE OR DELETE ON road_infraction_events
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER road_infraction_events_no_truncate BEFORE TRUNCATE ON road_infraction_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
