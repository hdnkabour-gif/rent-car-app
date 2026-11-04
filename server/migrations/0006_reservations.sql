-- 0006_reservations: bookings of a vehicle for a customer, priced per 24-hour day (BR-04), with
-- pickup/return place (BR-10), agreed price changes by an authorized user only (BR-06, BR-14),
-- and DATABASE-ENFORCED prevention of overlapping active reservations for the same vehicle.
-- Additive only.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Default price of a vehicle, in centimes of MAD (integer money, never floating point).
ALTER TABLE vehicles ADD COLUMN daily_rate_cents integer CHECK (daily_rate_cents BETWEEN 0 AND 100000000);
ALTER TABLE vehicles ADD COLUMN deposit_cents integer CHECK (deposit_cents BETWEEN 0 AND 100000000);

INSERT INTO permissions (code, description, grantable) VALUES
  ('reservations.read',   'See reservations of their branches', false),
  ('reservations.manage', 'Create, change and cancel reservations', false),
  ('pricing.change',      'Agree a price different from the vehicle price (change or discount), with a reason', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager',  'reservations.read'),
  ('manager',  'reservations.manage'),
  ('manager',  'pricing.change'),
  ('employee', 'reservations.read'),
  ('employee', 'reservations.manage');

CREATE SEQUENCE reservation_number_seq;

CREATE TABLE reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL UNIQUE DEFAULT nextval('reservation_number_seq'),
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,   -- pickup branch (scope)
  return_branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id         uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  period             tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  days               integer NOT NULL CHECK (days BETWEEN 1 AND 366),
  pickup_place       text NOT NULL DEFAULT 'agency' CHECK (pickup_place IN ('agency', 'airport', 'hotel', 'other')),
  pickup_details     text CHECK (length(pickup_details) <= 200),
  return_place       text NOT NULL DEFAULT 'agency' CHECK (return_place IN ('agency', 'airport', 'hotel', 'other')),
  return_details     text CHECK (length(return_details) <= 200),
  status             text NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed', 'cancelled', 'no_show', 'in_progress', 'completed')),
  list_daily_cents   integer NOT NULL CHECK (list_daily_cents >= 0),   -- vehicle price when booked
  daily_cents        integer NOT NULL CHECK (daily_cents >= 0),        -- agreed price per day
  price_reason       text CHECK (length(price_reason) <= 500),
  total_cents        bigint NOT NULL CHECK (total_cents >= 0),
  deposit_cents      integer NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),  -- planned; collected at handover
  notes              text CHECK (length(notes) <= 2000),
  cancel_reason      text CHECK (length(cancel_reason) <= 500),
  created_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (total_cents = days::bigint * daily_cents),
  CHECK (daily_cents = list_daily_cents OR price_reason IS NOT NULL),
  CHECK (status NOT IN ('cancelled', 'no_show') OR cancel_reason IS NOT NULL),
  -- Two active reservations can never overlap on the same vehicle, even under concurrent requests.
  CONSTRAINT reservations_no_overlap EXCLUDE USING gist (vehicle_id WITH =, period WITH &&)
    WHERE (status IN ('confirmed', 'in_progress'))
);
CREATE INDEX reservations_start_idx ON reservations (start_at);
CREATE INDEX reservations_end_idx ON reservations (end_at);
CREATE INDEX reservations_customer_idx ON reservations (customer_id, start_at DESC);
CREATE INDEX reservations_vehicle_idx ON reservations (vehicle_id, start_at);
CREATE INDEX reservations_branch_idx ON reservations (branch_id, start_at);

CREATE TRIGGER reservations_no_delete BEFORE DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER reservations_no_truncate BEFORE TRUNCATE ON reservations FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- Change history of every reservation (append-only).
CREATE TABLE reservation_events (
  id             bigserial PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  event          text NOT NULL CHECK (event IN ('created', 'changed', 'cancelled', 'no_show', 'reopened')),
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- reservation fields only (dates, vehicle, price...)
  reason         text CHECK (length(reason) <= 500),
  actor_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_events_reservation_idx ON reservation_events (reservation_id, id);
CREATE TRIGGER reservation_events_append_only BEFORE UPDATE OR DELETE ON reservation_events
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER reservation_events_no_truncate BEFORE TRUNCATE ON reservation_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
