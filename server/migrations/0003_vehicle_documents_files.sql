-- 0003_vehicle_documents_files: complete vehicle identity, private file storage metadata,
-- vehicle documents with expiry dates, vehicle photos. Additive only.

ALTER TABLE vehicles ADD COLUMN first_registration_date date
  CHECK (first_registration_date BETWEEN DATE '1980-01-01' AND DATE '2100-01-01');

INSERT INTO permissions (code, description, grantable) VALUES
  ('vehicles.documents', 'Add, edit and archive vehicle documents and photos', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES ('manager', 'vehicles.documents');

-- Stored files: metadata only. Bytes live in private storage under a random key (never a client name
-- or path). Originals are immutable: there is no UPDATE of storage_key/sha256 and no delete path.
CREATE TABLE stored_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  original_name text CHECK (length(original_name) <= 200),   -- sanitized, display only
  uploaded_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stored_files_storage_key_key ON stored_files (storage_key);
CREATE INDEX stored_files_sha256_idx ON stored_files (sha256);

CREATE FUNCTION stored_files_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'stored_files rows are never deleted'; END IF;
  IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.mime_type <> OLD.mime_type THEN
    RAISE EXCEPTION 'stored file content metadata is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stored_files_immutable BEFORE UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION stored_files_immutable();

-- Vehicle documents (registration card, insurance, technical inspection, ...) ----------------
CREATE TABLE vehicle_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  doc_type    text NOT NULL CHECK (doc_type IN ('registration', 'insurance', 'technical_inspection', 'vignette',
                                                'transport_authorization', 'other')),
  label       text CHECK (length(label) <= 120),          -- free name, required for "other"
  number      text CHECK (length(number) <= 80),
  issuer      text CHECK (length(issuer) <= 120),          -- insurer, inspection centre...
  issue_date  date,
  expiry_date date,
  notes       text CHECK (length(notes) <= 2000),
  file_id     uuid REFERENCES stored_files(id) ON DELETE RESTRICT,
  archived_at timestamptz,                                  -- replaced or no longer valid; kept for history
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date >= issue_date),
  CHECK (doc_type <> 'other' OR label IS NOT NULL)
);
CREATE INDEX vehicle_documents_vehicle_idx ON vehicle_documents (vehicle_id) WHERE archived_at IS NULL;
CREATE INDEX vehicle_documents_expiry_idx ON vehicle_documents (expiry_date) WHERE archived_at IS NULL;

-- Vehicle photos -----------------------------------------------------------------------------
CREATE TABLE vehicle_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  file_id     uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  caption     text CHECK (length(caption) <= 200),
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- The same file (same bytes) is attached once per vehicle: a network retry never creates a duplicate.
CREATE UNIQUE INDEX vehicle_photos_vehicle_file_key ON vehicle_photos (vehicle_id, file_id) WHERE archived_at IS NULL;
