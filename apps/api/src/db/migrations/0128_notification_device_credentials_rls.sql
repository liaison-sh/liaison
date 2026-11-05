-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.notification_device_credentials (0122) under the RLS guard.
--
-- The table holds the hashed receipt credentials of notification devices. Only
-- privileged code reads or writes it (modules/notifications/devices.ts: issue
-- and revoke through withPrivilegedDb, verify through withSystemDb), so the
-- request role has no business with it at all. 0122 enabled and forced RLS but
-- wrote no policy, and the schema-wide default privileges (0000) still granted
-- liaison_rls every DML on it: the protection was "no policy matches", by
-- accident rather than by statement, and the RLS completeness guard failed on
-- it. Now it is stated twice over:
--   - liaison_rls loses every privilege on the table (the role-grant boundary
--     the privileged-only tables use, 0000_initial.sql REVOKE ALL);
--   - a deny-all policy for liaison_rls says the same thing in the policy
--     layer, so the table stays governed by the guard instead of allowlisted.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

REVOKE ALL ON kernel.notification_device_credentials FROM liaison_rls;
--> statement-breakpoint
ALTER TABLE kernel.notification_device_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.notification_device_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS notification_device_credentials_privileged_only
  ON kernel.notification_device_credentials;
--> statement-breakpoint
CREATE POLICY notification_device_credentials_privileged_only
  ON kernel.notification_device_credentials FOR ALL TO liaison_rls
  USING (false)
  WITH CHECK (false);
