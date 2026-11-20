-- 0020 (RC-03, #26): give back rental money the customer overpaid, e.g. a paid late fee
-- that the manager later waives. A refund is a NEW append-only entry linked to the rental
-- receipt it gives money back from; the receipt itself is never edited (D-040).
--   rental_refund = money handed back to the customer from a rental receipt (cash or transfer),
--                   bounded by what is overpaid on the contract and what is left on that receipt.
-- No existing row changes: the kind list only grows, the new column is NULL for every old row.

ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check
  CHECK (kind IN ('rental', 'deposit_in', 'deposit_out', 'deposit_kept', 'reversal', 'rental_refund'));

ALTER TABLE payments ADD COLUMN refunds_id uuid REFERENCES payments(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_refund_link CHECK ((kind = 'rental_refund') = (refunds_id IS NOT NULL));
ALTER TABLE payments ADD CONSTRAINT payments_refund_reason CHECK (kind <> 'rental_refund' OR reason IS NOT NULL);
ALTER TABLE payments ADD CONSTRAINT payments_refund_method CHECK (kind <> 'rental_refund' OR method IN ('cash', 'transfer'));
CREATE INDEX payments_refunds_idx ON payments (refunds_id) WHERE refunds_id IS NOT NULL;

INSERT INTO permissions (code, description, grantable) VALUES
  ('payments.refund', 'Give back rental money the customer overpaid (with a reason)', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager', 'payments.refund');
