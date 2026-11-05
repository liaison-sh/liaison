-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Every invoicing document (invoice, quote, proforma, purchase order, credit
-- note) must be able to carry free-text notes: a contract reference, extra
-- customs information, a special mention the customer asked for. This is
-- non-financial metadata, so it stays editable on a draft AND on an already
-- issued, sent or paid document, and it is printed on the PDF.
--
-- Add the first-class column (same shape as 0045's po_number, minus the
-- external_refs mirror: notes has never been written anywhere else, so there is
-- nothing to backfill). `app_invoicing.documents` is NOT migration-tracked DDL
-- -- it is created by the runtime's additive DDL reconciler from the bundled
-- invoicing app's own manifest schema (app.manifest.json, which also declares
-- this field) at app registration/upgrade. This migration re-applies the column
-- explicitly for an org that installed invoicing BEFORE this shipped, and is a
-- no-op on a fresh database where invoicing has never been registered
-- (schema/table absent) -- the reconciler adds the column there instead, on the
-- next registration pass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
  ) THEN
    ALTER TABLE app_invoicing.documents ADD COLUMN IF NOT EXISTS notes TEXT;
  END IF;
END $$;
