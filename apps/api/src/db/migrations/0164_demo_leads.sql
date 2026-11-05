-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Demo leads: one row per "Start the demo" on a public demo instance.
--
-- The visitor's address is collected at signup under a notice shown on the
-- form (B2B prospecting: inform at collection, offer an easy opt-out), and it
-- is NOT the visitor's login (their account carries a generated internal
-- address, so an email never identifies or resumes a workspace). This table is
-- where the typed address lives.
--
--  - demo_org_id is a plain uuid, deliberately with NO foreign key: the row is
--    the durable record of the signup and must survive the demo org's expiry
--    and deletion by the reaper. There is no org_id column for the same
--    reason, which also keeps it out of the per-org reset rules.
--  - notice_version: the version string of the notice text the visitor saw.
--  - opt_out_token: unguessable, per lead, carried by an unsubscribe link;
--    opted_out_at is set by the unauthenticated opt-out route.
--
-- Instance-level, not tenant data: written and read only through the
-- privileged connection (the signup route, the operator-only export, the
-- opt-out route). liaison_rls gets nothing; RLS is forced with no policy as a
-- second wall. Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.demo_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  notice_version text NOT NULL CHECK (char_length(notice_version) BETWEEN 1 AND 64),
  demo_org_id uuid NULL,
  opt_out_token text NOT NULL CHECK (char_length(opt_out_token) >= 32),
  opted_out_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS demo_leads_opt_out_token_idx ON kernel.demo_leads (opt_out_token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS demo_leads_created_at_idx ON kernel.demo_leads (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS demo_leads_email_idx ON kernel.demo_leads (email);
--> statement-breakpoint
ALTER TABLE kernel.demo_leads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.demo_leads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.demo_leads FROM liaison_rls;
