-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A reconciliation that becomes an invoice.
--
-- reconciliations.document_ref is the exact external_ref the draft invoice got
-- when a person pressed Create (reconcile:<id>:<revision>, or
-- retainer:<schedule>:<YYYY-MM>). The invoicing app hands that key from the
-- draft to the invoice it issues, so claims follow it by the key, never by the
-- draft's id, which is gone once the invoice exists.
-- The rate, currency and hours in a day are frozen at Create, with who drafted
-- it and when, so a later change to the project's terms never changes a draft
-- or an invoice already made from the card.
-- billing_claims gains an index on its document, for the reads that follow an
-- invoice back to its claims. project_timeboxes.source_ref names the retainer
-- schedule a derived timebox comes from.
-- Columns and one index only: no CHECK, policy or grant changes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never writes these columns; every existing reconciliation has no invoice yet
ALTER TABLE app_projects.reconciliations
  ADD COLUMN document_ref text,
  ADD COLUMN create_rate_minor bigint,
  ADD COLUMN create_currency text,
  ADD COLUMN create_hours_per_day_minutes integer,
  ADD COLUMN drafted_at timestamptz,
  ADD COLUMN drafted_by uuid;
--> statement-breakpoint
-- expand-safe: the previous release never writes this column; every existing timebox is its own source
ALTER TABLE app_projects.project_timeboxes
  ADD COLUMN source_ref text;
--> statement-breakpoint
-- index-build: app_projects.billing_claims 20000 2
CREATE INDEX billing_claims_document_idx ON app_projects.billing_claims (org_id, document_id)
  WHERE document_id IS NOT NULL;
--> statement-breakpoint
-- index-build: app_projects.reconciliations 20000 2
CREATE INDEX reconciliations_document_ref_idx ON app_projects.reconciliations (org_id, document_ref)
  WHERE document_ref IS NOT NULL;
