-- RC-04: a content-addressed stored_file may be uploaded by multiple employees as an expense receipt.
-- Grant receipt-use rights only after a user supplies the actual bytes through the receipt endpoint.
-- No customer scans are automatically converted to receipts. File bytes remain globally deduplicated.
CREATE TABLE expense_receipt_upload_claims (
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, uploaded_by)
);

-- Preserve previously valid expense receipts; old code accepted only the original file uploader.
INSERT INTO expense_receipt_upload_claims (file_id, uploaded_by)
SELECT DISTINCT e.receipt_file_id, e.created_by
FROM expenses e
JOIN stored_files f ON f.id = e.receipt_file_id AND f.uploaded_by = e.created_by
WHERE e.kind = 'expense' AND e.receipt_file_id IS NOT NULL;

CREATE TRIGGER expense_receipt_claims_append_only BEFORE UPDATE OR DELETE ON expense_receipt_upload_claims
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER expense_receipt_claims_no_truncate BEFORE TRUNCATE ON expense_receipt_upload_claims
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
