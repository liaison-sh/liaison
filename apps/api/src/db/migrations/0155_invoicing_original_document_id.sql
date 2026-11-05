-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A credit note's link to the invoice it reverses becomes a first-class column.
-- Until now the only trace was `external_refs.original_document_id`. The column
-- is also declared in the bundled invoicing app's manifest schema, so the
-- runtime's additive DDL reconciler adds it at the next registration pass; this
-- migration adds it explicitly for an org that installed invoicing BEFORE this
-- shipped (same pattern as 0045) and is a no-op where invoicing was never
-- registered (schema/table absent).
--
-- It also stamps `external_refs.import_file_id` on imported documents: the
-- importer stored each source PDF as a system-uploaded kernel file named after
-- `external_refs.import_source`, but never recorded the file id, so the file is
-- only discoverable by name. The earliest matching file of the same org wins.
-- Idempotent: ADD COLUMN IF NOT EXISTS, and both UPDATEs only touch rows that
-- still lack the value.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
  ) THEN
    ALTER TABLE app_invoicing.documents ADD COLUMN IF NOT EXISTS original_document_id UUID;

    UPDATE app_invoicing.documents
    SET original_document_id = (external_refs->>'original_document_id')::uuid
    WHERE original_document_id IS NULL
      AND external_refs->>'original_document_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    UPDATE app_invoicing.documents d
    SET external_refs = d.external_refs || jsonb_build_object('import_file_id', f.id::text)
    FROM (
      SELECT DISTINCT ON (org_id, filename) org_id, filename, id
      FROM kernel.files
      WHERE app = 'invoicing' AND entity_type = 'pdf' AND uploaded_by IS NULL
      ORDER BY org_id, filename, created_at, id
    ) f
    WHERE f.org_id = d.org_id
      AND f.filename = d.external_refs->>'import_source'
      AND NOT (d.external_refs ? 'import_file_id');
  END IF;
END $$;
