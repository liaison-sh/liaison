-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Issued client documents carry the company they are made out to.
--
-- A document's `company_id` (invoicing manifest) is what the client portal and the company page
-- read. It was stamped at issue from the counterparty contact's company only, so a document whose
-- contact gained a company later, or was issued by someone who could not read that company, kept
-- none: the portal missed an owed invoice and the company page said it had none. This fills the
-- rows still without a company, in this order:
--   1. the counterparty contact's own company (the document carries that contact's name,
--      address and VAT id, so it belongs to that contact's company);
--   2. only for an invoice or a credit note whose contact is on file with no company (or which
--      names no contact): the company of the schedule whose month-end row points at it;
--   3. same condition: the client company of the project it bills.
-- A source company never overrides or stands in for a contact's company, so an invoice made out
-- to company B is never put in company A's portal. Quotes, proformas and purchase orders (a
-- supplier's) never take a source company. A no-op where invoicing or projects is absent.
-- Re-runnable.
-- reviewed-dynamic: three guarded UPDATEs of rows whose company_id is NULL, run only where the tables exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_invoicing' AND table_name = 'documents' AND column_name = 'company_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kernel' AND table_name = 'contacts' AND column_name = 'company_id'
  ) THEN
    UPDATE app_invoicing.documents d
       SET company_id = c.company_id
      FROM kernel.contacts c
     WHERE d.company_id IS NULL
       AND d.counterparty_contact_id IS NOT NULL
       AND c.id = d.counterparty_contact_id AND c.org_id = d.org_id
       AND c.company_id IS NOT NULL;

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
         AND d.type IN ('invoice', 'credit_note')
         AND (
           d.counterparty_contact_id IS NULL
           OR EXISTS (
             SELECT 1 FROM kernel.contacts c
              WHERE c.id = d.counterparty_contact_id AND c.org_id = d.org_id
                AND c.company_id IS NULL
           )
         )
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
         AND d.type IN ('invoice', 'credit_note')
         AND (
           d.counterparty_contact_id IS NULL
           OR EXISTS (
             SELECT 1 FROM kernel.contacts c
              WHERE c.id = d.counterparty_contact_id AND c.org_id = d.org_id
                AND c.company_id IS NULL
           )
         )
         AND d.billing_project_id IS NOT NULL
         AND p.id = d.billing_project_id AND p.org_id = d.org_id
         AND p.company_id IS NOT NULL;
    END IF;
  END IF;
END $$;
