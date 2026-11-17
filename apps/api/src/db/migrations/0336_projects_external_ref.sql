-- A project made by another app's step (a signed agreement starting its project) names
-- that step: a second delivery of the same step finds the project instead of making one.
-- NULL for every project a person makes; unique per org when set.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a nullable column with no default; the previous release never reads it
ALTER TABLE app_projects.projects ADD COLUMN IF NOT EXISTS external_ref text;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- index-build: app_projects.projects 20000 2
CREATE UNIQUE INDEX IF NOT EXISTS app_projects_org_external_ref_uidx
  ON app_projects.projects (org_id, external_ref) WHERE external_ref IS NOT NULL;
