-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Every quote and invoice must be able to carry the customer's purchase order
-- number. Until now nothing in invoicing held it as a first-class field: the
-- only trace was `external_refs.po_number`, written by the legacy CSV importer
-- (apps/api/src/cli/invoicing/import.ts) and read by nothing.
--
-- Add the first-class column (mirrors the existing shopify_order_id /
-- shopify_order_number / shipment_ref / shopify_draft_order_id pattern: a
-- top-level indexed-searchable column, kept in sync with external_refs.po_number)
-- and backfill existing data. `app_invoicing.documents` is NOT migration-tracked
-- DDL -- it is created by the runtime's additive DDL reconciler from the bundled
-- invoicing app's own manifest schema (app.manifest.json, which also declares
-- this field) at app registration/upgrade, same pattern as 0012's RLS fix. This
-- migration re-applies the column explicitly and backfills for an org that
-- installed invoicing BEFORE this shipped, and is a no-op on a fresh database
-- where invoicing has never been registered (schema/table absent) -- the
-- reconciler adds the column there instead, on the next registration pass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
  ) THEN
    ALTER TABLE app_invoicing.documents ADD COLUMN IF NOT EXISTS po_number TEXT;

    -- Backfill: legacy imported documents already carry the PO number on
    -- external_refs.po_number (written by the CSV importer). Surface it onto
    -- the new column so it is immediately searchable and visible in the
    -- list/detail views for the whole import history, without waiting on a
    -- re-render.
    UPDATE app_invoicing.documents
    SET po_number = NULLIF(TRIM(external_refs->>'po_number'), '')
    WHERE po_number IS NULL
      AND external_refs ? 'po_number'
      AND NULLIF(TRIM(external_refs->>'po_number'), '') IS NOT NULL;
  END IF;
END $$;
