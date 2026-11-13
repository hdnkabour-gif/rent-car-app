-- Manager-approved OCR values remain separate from customer profiles and rental contracts.
-- Never copy unreviewed OCR proposals into business records.
CREATE TABLE customer_intake_document_reviews (
  document_id uuid PRIMARY KEY REFERENCES customer_intake_documents(id) ON DELETE RESTRICT,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  status text NOT NULL CHECK (status IN ('approved','rejected')),
  reviewed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text,
  CHECK (octet_length(fields::text) <= 12000)
);
CREATE TRIGGER customer_intake_document_reviews_no_delete BEFORE DELETE ON customer_intake_document_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER customer_intake_document_reviews_no_truncate BEFORE TRUNCATE ON customer_intake_document_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();

-- The audit log stores old/new field values on each review so changes are traceable.
