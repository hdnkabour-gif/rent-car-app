-- 0014: store only non-biometric, orientation-dependent image fingerprints and quality metrics.
-- No OCR text, face template, document number or identity prediction is stored in this table.
CREATE TABLE customer_intake_document_analysis (
  document_id uuid PRIMARY KEY REFERENCES customer_intake_documents(id) ON DELETE RESTRICT,
  visual_hash text NOT NULL CHECK (visual_hash ~ '^[0-9a-f]{16}$'),
  blur_variance numeric NOT NULL CHECK (blur_variance >= 0),
  brightness numeric NOT NULL CHECK (brightness BETWEEN 0 AND 255),
  analyzed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  analyzed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_intake_document_analysis_visual_idx ON customer_intake_document_analysis(visual_hash);
CREATE TRIGGER customer_intake_document_analysis_no_delete BEFORE DELETE ON customer_intake_document_analysis
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER customer_intake_document_analysis_no_truncate BEFORE TRUNCATE ON customer_intake_document_analysis
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
