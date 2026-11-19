-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Invoices made by a recurring schedule or for a project carry their client company.
--
-- A document's `company_id` (invoicing manifest) is what the client portal and the company page
-- read. It was stamped at issue from the counterparty contact's company only, so an invoice made
-- by a schedule or a billing plan whose contact has no company (or whose company could not be
-- read by the person issuing it) kept none: the portal missed an owed invoice and the company
-- page said it had none. The app now stamps the company on the draft from its source; this fills
-- the rows written before, where the company can be derived:
--   1. a document a month-end run row points at takes its schedule's company;
--   2. a document billing a project takes the project's client company.
-- Only rows still without a company are touched; a no-op where invoicing or projects is absent.
-- Re-runnable.
-- reviewed-dynamic: two guarded UPDATEs of rows whose company_id is NULL, run only where the tables exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_invoicing' AND table_name = 'documents' AND column_name = 'company_id'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'app_invoicing' AND table_name = 'recurring_schedules'
        AND column_name = 'company_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'app_invoicing' AND table_name = 'recurring_run_items'
    ) THEN
      UPDATE app_invoicing.documents d
         SET company_id = s.company_id
        FROM app_invoicing.recurring_run_items i
        JOIN app_invoicing.recurring_schedules s
          ON s.id = i.schedule_id AND s.org_id = i.org_id
       WHERE d.company_id IS NULL
         AND i.document_id = d.id AND i.org_id = d.org_id
         AND s.company_id IS NOT NULL;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
        AND column_name = 'billing_project_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'app_projects' AND table_name = 'projects' AND column_name = 'company_id'
    ) THEN
      UPDATE app_invoicing.documents d
         SET company_id = p.company_id
        FROM app_projects.projects p
       WHERE d.company_id IS NULL
         AND d.billing_project_id IS NOT NULL
         AND p.id = d.billing_project_id AND p.org_id = d.org_id
         AND p.company_id IS NOT NULL;
    END IF;
  END IF;
END $$;
