-- 0016: independent manual verification for vehicle paperwork and signed contracts.
-- Fields are a manager-reviewed snapshot only, never an automated mutation of fleet, contracts, or customers.
-- Key each approval to the exact immutable file_id: replacing the scan cannot inherit approval.
CREATE TABLE vehicle_document_reviews (
  document_id uuid NOT NULL REFERENCES vehicle_documents(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 12000),
  status text NOT NULL CHECK (status IN ('approved', 'rejected')),
  reviewed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text CHECK (length(reason) <= 500),
  PRIMARY KEY(document_id, file_id)
);
CREATE TRIGGER vehicle_document_reviews_no_delete BEFORE DELETE ON vehicle_document_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER vehicle_document_reviews_no_truncate BEFORE TRUNCATE ON vehicle_document_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

CREATE TABLE contract_signed_scan_reviews (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 12000),
  status text NOT NULL CHECK (status IN ('approved', 'rejected')),
  reviewed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text CHECK (length(reason) <= 500),
  PRIMARY KEY(contract_id, file_id)
);
CREATE TRIGGER contract_signed_scan_reviews_no_delete BEFORE DELETE ON contract_signed_scan_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER contract_signed_scan_reviews_no_truncate BEFORE TRUNCATE ON contract_signed_scan_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
