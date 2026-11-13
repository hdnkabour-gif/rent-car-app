-- 0012: pre-booking customer intake. No reservation, contract or customer is created automatically.
-- Public invitation codes are represented by salted hashes; only the creating manager may view submissions.
CREATE TABLE customer_intake_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  days integer NOT NULL CHECK (days BETWEEN 1 AND 366),
  daily_cents integer NOT NULL CHECK (daily_cents BETWEEN 0 AND 100000000),
  deposit_cents integer NOT NULL CHECK (deposit_cents BETWEEN 0 AND 100000000),
  code_salt text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'revoked', 'accepted')),
  consent_at timestamptz,
  submitted_at timestamptz,
  accepted_customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (expires_at > created_at),
  CHECK (status <> 'accepted' OR accepted_customer_id IS NOT NULL)
);
CREATE INDEX customer_intake_links_created_idx ON customer_intake_links(created_by, created_at DESC);
CREATE INDEX customer_intake_links_expiry_idx ON customer_intake_links(expires_at) WHERE status = 'open';

CREATE TABLE customer_intake_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid NOT NULL REFERENCES customer_intake_links(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('id_front','id_back','passport','licence_front','licence_back','residence_permit','other')),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intake_id,file_id)
);
CREATE INDEX customer_intake_documents_link_idx ON customer_intake_documents(intake_id);

CREATE TRIGGER customer_intake_links_no_delete BEFORE DELETE ON customer_intake_links
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER customer_intake_links_no_truncate BEFORE TRUNCATE ON customer_intake_links
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER customer_intake_documents_no_delete BEFORE DELETE ON customer_intake_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER customer_intake_documents_no_truncate BEFORE TRUNCATE ON customer_intake_documents
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
