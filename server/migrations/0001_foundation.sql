-- 0001_foundation: identity, roles/permissions, sessions, company settings, audit log.
-- Applied by src/db/migrate.ts inside a single transaction.

-- Roles -----------------------------------------------------------------------
CREATE TABLE roles (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  name_fr     text NOT NULL,
  name_ar     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

INSERT INTO roles (code, name_fr, name_ar) VALUES
  ('manager',  'Gérant',  'مدير'),
  ('employee', 'Employé', 'موظف');

INSERT INTO permissions (code, description) VALUES
  ('dashboard.view',          'View the operational dashboard'),
  ('company_settings.read',   'Read company identity and document settings'),
  ('company_settings.update', 'Change company identity and document settings'),
  ('users.read',              'List staff accounts'),
  ('users.manage',            'Create staff accounts, change roles, activate/deactivate'),
  ('audit_logs.read',         'Read the audit log');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager',  'dashboard.view'),
  ('manager',  'company_settings.read'),
  ('manager',  'company_settings.update'),
  ('manager',  'users.read'),
  ('manager',  'users.manage'),
  ('manager',  'audit_logs.read'),
  ('employee', 'dashboard.view'),
  ('employee', 'company_settings.read');

-- Users -----------------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  full_name            text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  role_code            text NOT NULL REFERENCES roles(code),
  password_hash        text NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  preferred_language   text NOT NULL DEFAULT 'fr' CHECK (preferred_language IN ('fr', 'ar')),
  failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_role_code_idx ON users (role_code);

-- Sessions (database-backed, opaque token; only a SHA-256 hash is stored) -----
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text CHECK (revoked_reason IN ('logout', 'logout_all', 'user_deactivated', 'role_changed', 'password_changed', 'admin')),
  user_agent      text CHECK (length(user_agent) <= 512),
  CHECK (idle_expires_at <= expires_at)
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Company settings (single row; company identity is independent from product identity)
CREATE TABLE company_settings (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name            text NOT NULL DEFAULT '' CHECK (length(legal_name) <= 200),
  trade_name            text NOT NULL DEFAULT '' CHECK (length(trade_name) <= 200),
  -- Storage key of the logo file. Logo upload arrives with the file-storage adapter (slice 2).
  logo_storage_key      text CHECK (length(logo_storage_key) <= 255),
  ice                   text CHECK (ice ~ '^[0-9]{15}$'),
  if_number             text CHECK (if_number ~ '^[0-9]{1,15}$'),
  rc_number             text CHECK (length(rc_number) <= 50),
  rc_city               text CHECK (length(rc_city) <= 100),
  patente               text CHECK (length(patente) <= 50),
  address_line          text CHECK (length(address_line) <= 300),
  city                  text CHECK (length(city) <= 100),
  postal_code           text CHECK (length(postal_code) <= 20),
  country_code          char(2) NOT NULL DEFAULT 'MA' CHECK (country_code ~ '^[A-Z]{2}$'),
  phone                 text CHECK (length(phone) <= 30),
  email                 text CHECK (length(email) <= 254),
  website               text CHECK (length(website) <= 255),
  currency              char(3) NOT NULL DEFAULT 'MAD' CHECK (currency ~ '^[A-Z]{3}$'),
  timezone              text NOT NULL DEFAULT 'Africa/Casablanca' CHECK (length(timezone) <= 64),
  default_language      text NOT NULL DEFAULT 'fr' CHECK (default_language IN ('fr', 'ar')),
  document_languages    text[] NOT NULL DEFAULT ARRAY['fr', 'ar'] CHECK (document_languages <@ ARRAY['fr', 'ar'] AND cardinality(document_languages) >= 1),
  brand_primary_color   text NOT NULL DEFAULT '#1F4E79' CHECK (brand_primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  show_company_branding boolean NOT NULL DEFAULT true,
  document_header_text  text CHECK (length(document_header_text) <= 1000),
  document_footer_text  text CHECK (length(document_footer_text) <= 1000),
  signatory_name        text CHECK (length(signatory_name) <= 120),
  signatory_title       text CHECK (length(signatory_title) <= 120),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO company_settings (id) VALUES (1);

-- Audit log (append-only) ------------------------------------------------------
CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- Users are deactivated, never hard-deleted, so the actor reference is RESTRICT.
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action        text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  outcome       text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied')),
  target_type   text CHECK (length(target_type) <= 60),
  target_id     text CHECK (length(target_id) <= 100),
  request_id    text CHECK (length(request_id) <= 100),
  ip_address    inet,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();
