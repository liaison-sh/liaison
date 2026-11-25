-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The second half of `organizations.class` (0309): the class an org is created with never
-- changes, and only a `demo` org can carry the demo marker `settings.demo`. 0309 gave every
-- marked org its class, and the release that shipped it writes the class at insert; this one
-- makes the database hold both rules, so a bad write to `settings` can no longer turn a
-- customer's org into a demo one.
--
-- No backfill. A marked org still of class `standard` stops the migration: it is either a
-- workspace a demo instance made during the rolling deploy to 0309 (run `liaison demo
-- reclassify` of that release on it), or a customer org whose `settings.demo` somebody wrote
-- (remove the key). Which one it is takes a person; the migration never decides it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
GRANT USAGE ON SCHEMA kernel TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.organizations TO liaison_admin;
--> statement-breakpoint
-- The table forces row security (see 0283 and 0309): the guard reads it as liaison_admin.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: reads only, then raises; no DDL.
DO $$
DECLARE marked text;
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'org class constraints: % is held to row security, so the orgs cannot all be read; give it BYPASSRLS (as 0000 does), then migrate again', current_user;
  END IF;
  SELECT string_agg(o.id::text, ', ' ORDER BY o.id) INTO marked
    FROM kernel.organizations o
   WHERE o.class = 'standard'
     AND jsonb_typeof(o.settings->'demo') = 'object';
  IF marked IS NOT NULL THEN
    RAISE EXCEPTION 'org class constraints: these orgs carry a demo marker (settings.demo) but are of class standard: %. For a demo instance''s own workspaces made during the upgrade to the previous release, run `liaison demo reclassify` of that release on them; for any other org, remove settings.demo. Then migrate again', marked;
  END IF;
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
CREATE FUNCTION kernel.organizations_class_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.class IS DISTINCT FROM OLD.class THEN
    RAISE EXCEPTION 'organizations.class never changes: org % is %, not %', OLD.id, OLD.class, NEW.class
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- expand-safe: the previous release writes the class only when it inserts an org; its one update of it is the operator's `demo reclassify`, which this release removes.
CREATE TRIGGER organizations_class_immutable
  BEFORE UPDATE OF class ON kernel.organizations
  FOR EACH ROW EXECUTE FUNCTION kernel.organizations_class_immutable();
--> statement-breakpoint
-- expand-safe: the previous release marks only the orgs it creates as `demo`, and the guard above proved no existing row breaks it.
ALTER TABLE kernel.organizations
  ADD CONSTRAINT organizations_demo_marker_class_check
    CHECK (class = 'demo' OR jsonb_typeof(settings->'demo') IS DISTINCT FROM 'object') NOT VALID;
--> statement-breakpoint
-- expand-safe: validates the constraint added above; the guard proved every row satisfies it.
ALTER TABLE kernel.organizations VALIDATE CONSTRAINT organizations_demo_marker_class_check;
