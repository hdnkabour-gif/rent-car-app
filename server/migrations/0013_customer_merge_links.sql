-- 0013: reversible, audited logical customer linking. Never rewrite historical contract,
-- payment, reservation or document foreign keys; originals remain accessible for legal audit.
CREATE TABLE customer_merge_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  canonical_customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  linked_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT now(),
  reversed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reverse_reason text CHECK (length(btrim(reverse_reason)) BETWEEN 10 AND 1000),
  CHECK (source_customer_id <> canonical_customer_id),
  CHECK ((status = 'active' AND reversed_by IS NULL AND reversed_at IS NULL AND reverse_reason IS NULL)
      OR (status = 'reversed' AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reverse_reason IS NOT NULL))
);
CREATE UNIQUE INDEX customer_merge_active_source_idx ON customer_merge_links(source_customer_id) WHERE status='active';
CREATE INDEX customer_merge_canonical_idx ON customer_merge_links(canonical_customer_id) WHERE status='active';

CREATE FUNCTION customer_merge_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'customer merge history must never be deleted'; END IF;
  IF OLD.id <> NEW.id OR OLD.source_customer_id <> NEW.source_customer_id
     OR OLD.canonical_customer_id <> NEW.canonical_customer_id OR OLD.reason <> NEW.reason
     OR OLD.linked_by <> NEW.linked_by OR OLD.linked_at <> NEW.linked_at
     OR OLD.status <> 'active' OR NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'customer merge links can only be reversed, never rewritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_merge_immutable BEFORE UPDATE OR DELETE ON customer_merge_links
  FOR EACH ROW EXECUTE FUNCTION customer_merge_immutability();
CREATE TRIGGER customer_merge_no_truncate BEFORE TRUNCATE ON customer_merge_links
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
