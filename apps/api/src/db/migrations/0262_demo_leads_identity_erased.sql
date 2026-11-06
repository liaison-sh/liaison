-- SPDX-License-Identifier: FSL-1.1-ALv2
--
-- A demo signup that did not opt in to news keeps no identity once its
-- workspace has expired: the hourly lead sweep empties the email and the name
-- and sets identity_erased_at (demo-leads.ts). The checks from 0164 and 0165
-- required both, so they now allow an empty value once, and only once, the row
-- says it was erased. Additive; rows written before this migration stay valid.
-- Re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS identity_erased_at timestamptz NULL;
--> statement-breakpoint
-- expand-safe: replaced in this file by a check that only allows more; the previous release writes rows both checks accept.
ALTER TABLE kernel.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_email_check;
--> statement-breakpoint
-- expand-safe: replaced in this file by a check that only allows more; the previous release writes rows both checks accept.
ALTER TABLE kernel.demo_leads ADD CONSTRAINT demo_leads_email_check
  CHECK (
    email = lower(email)
    AND (char_length(email) BETWEEN 3 AND 254 OR (email = '' AND identity_erased_at IS NOT NULL))
  );
--> statement-breakpoint
-- expand-safe: replaced in this file by a check that only allows more; the previous release writes rows both checks accept.
ALTER TABLE kernel.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_name_check;
--> statement-breakpoint
-- expand-safe: replaced in this file by a check that only allows more; the previous release writes rows both checks accept.
ALTER TABLE kernel.demo_leads ADD CONSTRAINT demo_leads_name_check
  CHECK (
    char_length(name) <= 80
    AND (char_length(name) >= 1 OR opted_out_at IS NOT NULL OR identity_erased_at IS NOT NULL)
  );
