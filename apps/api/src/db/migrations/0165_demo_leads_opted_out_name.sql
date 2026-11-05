-- SPDX-License-Identifier: FSL-1.1-ALv2
--
-- An opted-out demo lead keeps only its address: the opt-out wipes the name
-- (demo-leads.ts, as the published privacy notice promises). The name check
-- from 0164 required at least one character, so it now allows an empty name
-- once, and only once, the lead has opted out.
ALTER TABLE kernel.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_name_check;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD CONSTRAINT demo_leads_name_check
  CHECK (char_length(name) <= 80 AND (char_length(name) >= 1 OR opted_out_at IS NOT NULL));
