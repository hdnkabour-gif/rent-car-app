-- 0005_no_delete_business_data: company records can never be deleted or truncated, whatever the
-- application code does. Records are deactivated, archived, cancelled or corrected instead, so
-- the history stays complete (CLAUDE.md data protection, D-023, D-035).
-- Excluded on purpose: sessions (expire), user_branches / user_permission_grants (current
-- assignment sets, every change audited), configuration tables seeded by migrations.

CREATE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows of % are never deleted: archive, deactivate or cancel them instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'company_settings', 'branches', 'vehicles', 'vehicle_documents', 'vehicle_photos',
                           'customers', 'customer_documents']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete()', t || '_no_truncate', t);
  END LOOP;
END;
$$;

-- vehicle_status_history and audit_logs already block TRUNCATE; stored_files blocks DELETE (0003).
CREATE TRIGGER stored_files_no_truncate BEFORE TRUNCATE ON stored_files
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
