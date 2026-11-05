-- SPDX-License-Identifier: FSL-1.1-ALv2
-- 0198 created app_mcp_manager.mcp_connection_access without handing it to
-- liaison_admin, so it stayed owned by the role that ran the migration. Every
-- other table in an app schema is liaison_admin's (the schema's owner, and
-- the owner the app schema path creates tables as), and the roles that act
-- through liaison_admin reach those tables with the owner's rights: a
-- whole-database reset (tests, demo) truncates kernel.organizations CASCADE,
-- which reaches this table through its org_id foreign key and was refused
-- ("permission denied for table mcp_connection_access"). The explicit grants
-- 0198 made stay as they are.
--
-- Re-runnable (an owner change to the current owner is a no-op).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connection_access OWNER TO liaison_admin;
