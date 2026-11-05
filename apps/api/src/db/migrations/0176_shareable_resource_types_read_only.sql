-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.shareable_resource_types is read-only for the request and app roles,
-- as 0117 meant it to be.
--
-- The table maps a resource type to the function kernel.can_manage_sharing /
-- kernel.can_read_resource call and the table they read. It has no org_id and
-- no RLS: one row decides sharing authority for every org. 0117 granted
-- SELECT only, but the kernel schema's default privileges (0000_initial.sql)
-- had already given liaison_rls and liaison_app INSERT, UPDATE and DELETE on
-- it at creation. Rows are written by migrations only. Re-runnable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON kernel.shareable_resource_types FROM liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT ON kernel.shareable_resource_types TO liaison_rls, liaison_app;
