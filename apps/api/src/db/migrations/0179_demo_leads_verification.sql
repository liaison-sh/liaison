-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Demo leads learn who the visitor proved to be, what they came for, and from
-- where.
--
--  - email_normalized: the mailbox the typed address reaches (lowercase,
--    punycode domain, +tag and Gmail dots dropped, Proton family folded). The
--    visitor's spend budget is keyed on it once verified.
--  - email_cap_key: the registrable domain (or alias relay) the per-domain
--    verification cap counts on; NULL for a major mailbox provider (uncapped).
--  - verified_at: when the visitor confirmed the address (code or link).
--  - notify_managed_at: the one-click "tell me when managed launches".
--  - needs: what the visitor picked on the door, in pick order.
--  - signup_network: the client network (IPv4 /24, IPv6 /48) recorded at Start
--    and never changed; verification and spend read it from here.
--
-- Additive and nullable (needs defaults to empty), so rows written before this
-- migration stay valid. Re-runnable.
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS email_normalized text NULL;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS email_cap_key text NULL;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS notify_managed_at timestamptz NULL;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS needs text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ADD COLUMN IF NOT EXISTS signup_network text NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS demo_leads_email_normalized_idx ON kernel.demo_leads (email_normalized);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS demo_leads_demo_org_id_idx ON kernel.demo_leads (demo_org_id);
