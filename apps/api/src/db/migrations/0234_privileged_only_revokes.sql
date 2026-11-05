-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.instance_settings (0231) and kernel.mailbox_server_keys (0229) are
-- read and written only through the privileged pool (FORCE RLS, no policy),
-- but the request role kept the default privileges on them. Take them back,
-- as 0225 and 0226 did for their ledgers, so the request role holds no
-- privilege at all on either table (db/rls-completeness.test.ts).
--
-- Re-runnable; no code path of the request role touches these tables.
-- expand-safe: no release reads this table on the request role; the privileged pool is unchanged
REVOKE ALL ON kernel.instance_settings FROM liaison_rls;
--> statement-breakpoint
-- expand-safe: no release reads this table on the request role; the privileged pool is unchanged
REVOKE ALL ON kernel.mailbox_server_keys FROM liaison_rls;
