-- 0002_branches_fleet: branches (multi-branch from day one, BR-02), user branch assignment,
-- per-user permission grants (BR-14), vehicles with the owner-reviewed lifecycle (D-028, BR-09),
-- database-enforced transitions and append-only status history.
-- Additive only: no existing table or row is changed except new permission rows.

-- Permissions that a manager may delegate to a specific employee --------------
ALTER TABLE permissions ADD COLUMN grantable boolean NOT NULL DEFAULT false;

INSERT INTO permissions (code, description, grantable) VALUES
  ('branches.read',        'See branches (own branches, or all with branches.all)', false),
  ('branches.manage',      'Create and edit branches', false),
  ('branches.all',         'Work across all branches', true),
  ('vehicles.read',        'See vehicles and their history', false),
  ('vehicles.manage',      'Add vehicles and edit their details or branch', true),
  ('vehicles.inspect',     'Record an inspection: make a returned vehicle available or send it to maintenance', false),
  ('vehicles.maintenance', 'Send a vehicle to planned maintenance and close maintenance', true),
  ('vehicles.admin',       'Block, unblock and retire vehicles; correct mileage downwards with a reason', true);

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager',  'branches.read'),
  ('manager',  'branches.manage'),
  ('manager',  'branches.all'),
  ('manager',  'vehicles.read'),
  ('manager',  'vehicles.manage'),
  ('manager',  'vehicles.inspect'),
  ('manager',  'vehicles.maintenance'),
  ('manager',  'vehicles.admin'),
  ('employee', 'branches.read'),
  ('employee', 'vehicles.read'),
  ('employee', 'vehicles.inspect');

CREATE TABLE user_permission_grants (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  granted_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_code)
);

-- Effective permissions = role permissions + individual grants.
CREATE VIEW user_effective_permissions AS
  SELECT u.id AS user_id, rp.permission_code
    FROM users u JOIN role_permissions rp ON rp.role_code = u.role_code
  UNION
  SELECT g.user_id, g.permission_code FROM user_permission_grants g;

-- Branches ---------------------------------------------------------------------
CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,6}$'),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  city       text NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 100),
  address    text CHECK (length(address) <= 300),
  phone      text CHECK (length(phone) <= 30),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_code_key ON branches (code);

CREATE TABLE user_branches (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, branch_id)
);
CREATE INDEX user_branches_branch_idx ON user_branches (branch_id);

-- Vehicles -----------------------------------------------------------------------
-- Physical/operational state only. "Reserved" is NOT a state: it will be derived from bookings.
CREATE TABLE vehicles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  internal_code     text CHECK (internal_code ~ '^[A-Za-z0-9-]{1,20}$'),
  plate             text NOT NULL CHECK (length(btrim(plate)) BETWEEN 2 AND 30),  -- as written by staff
  plate_key         text NOT NULL CHECK (length(plate_key) BETWEEN 2 AND 30),     -- normalized search key
  make              text NOT NULL CHECK (length(btrim(make)) BETWEEN 1 AND 60),
  model             text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 60),
  version           text CHECK (length(version) <= 60),
  model_year        smallint CHECK (model_year BETWEEN 1980 AND 2100),
  color             text CHECK (length(color) <= 40),
  fuel_type         text NOT NULL CHECK (fuel_type IN ('diesel', 'petrol', 'hybrid', 'electric', 'lpg')),
  transmission      text NOT NULL CHECK (transmission IN ('manual', 'automatic')),
  seats             smallint CHECK (seats BETWEEN 1 AND 60),
  category          text CHECK (length(category) <= 40),
  vin               text CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  status            text NOT NULL DEFAULT 'inspection_pending'
                    CHECK (status IN ('available', 'rented', 'inspection_pending', 'maintenance', 'out_of_service', 'retired')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  mileage_km        integer NOT NULL DEFAULT 0 CHECK (mileage_km BETWEEN 0 AND 5000000),
  fuel_eighths      smallint CHECK (fuel_eighths BETWEEN 0 AND 8),   -- null until the first inspection
  notes             text CHECK (length(notes) <= 2000),
  created_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- A plate can be reused only after the earlier vehicle is retired.
CREATE UNIQUE INDEX vehicles_plate_key_active ON vehicles (plate_key) WHERE status <> 'retired';
CREATE UNIQUE INDEX vehicles_internal_code_key ON vehicles (internal_code) WHERE internal_code IS NOT NULL;
CREATE INDEX vehicles_branch_status_idx ON vehicles (branch_id, status);

-- Allowed transitions (data, so the rule lives in one place and the trigger enforces it) ---
CREATE TABLE vehicle_status_transitions (
  from_status     text NOT NULL,
  to_status       text NOT NULL,
  -- Permission needed for a manual change; NULL = only a business workflow may do it (check-out, check-in).
  permission_code text REFERENCES permissions(code),
  reason_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO vehicle_status_transitions (from_status, to_status, permission_code, reason_required) VALUES
  ('available',          'rented',             NULL,                   false), -- check-out workflow (slice 4)
  ('rented',             'inspection_pending', NULL,                   false), -- check-in workflow (slice 4)
  ('inspection_pending', 'available',          'vehicles.inspect',     false), -- inspection passed
  ('inspection_pending', 'maintenance',        'vehicles.inspect',     true),  -- needs repair
  ('available',          'maintenance',        'vehicles.maintenance', true),  -- planned service
  ('maintenance',        'inspection_pending', 'vehicles.maintenance', false), -- repair done: inspect before renting
  ('available',          'out_of_service',     'vehicles.admin',       true),  -- block
  ('inspection_pending', 'out_of_service',     'vehicles.admin',       true),
  ('maintenance',        'out_of_service',     'vehicles.admin',       true),
  ('out_of_service',     'inspection_pending', 'vehicles.admin',       true),  -- unblock: inspect before renting
  ('out_of_service',     'retired',            'vehicles.admin',       true);  -- retired is final

CREATE FUNCTION vehicles_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
       SELECT 1 FROM vehicle_status_transitions t WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
    RAISE EXCEPTION 'vehicle status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicles_status_transition
  BEFORE UPDATE OF status ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_enforce_transition();

-- A new vehicle always starts in inspection_pending: nothing is rentable without a first inspection.
CREATE FUNCTION vehicles_enforce_initial_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'inspection_pending' THEN
    RAISE EXCEPTION 'a new vehicle must start in inspection_pending' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vehicles_initial_status BEFORE INSERT ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_enforce_initial_status();

-- Append-only status history ---------------------------------------------------------
CREATE TABLE vehicle_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  from_status  text,                    -- NULL for the creation entry
  to_status    text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  reason       text CHECK (length(reason) <= 1000),
  mileage_km   integer CHECK (mileage_km >= 0),
  fuel_eighths smallint CHECK (fuel_eighths BETWEEN 0 AND 8),
  cleaned      boolean,                 -- BR-08: washing recorded at inspection
  notes        text CHECK (length(notes) <= 2000),
  ref_type     text CHECK (length(ref_type) <= 40),   -- e.g. contract, maintenance (later slices)
  ref_id       text CHECK (length(ref_id) <= 100)
);
CREATE INDEX vehicle_status_history_vehicle_idx ON vehicle_status_history (vehicle_id, id DESC);

CREATE FUNCTION block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER vehicle_status_history_no_update_delete
  BEFORE UPDATE OR DELETE ON vehicle_status_history
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER vehicle_status_history_no_truncate
  BEFORE TRUNCATE ON vehicle_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION block_mutation();
