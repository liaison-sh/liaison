-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Org-private custom apps (managed edition): an installed app version may
-- belong to ONE organization (modules/apps/app-org-scope.ts). NULL = an
-- instance app, as every row was before: self-hosted servers and catalog apps
-- never write it. `kernel.apps_active_version.org_id` already exists (0212,
-- always NULL until now); the activation copies it from the version's row.
-- The org purge uninstalls an org's apps (files, schema, schedulers) before
-- its rows go; the cascade is the backstop for the rows alone.
--
-- Additive and nullable, every statement re-runnable: the previous release
-- never reads or writes the column.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never writes, so the key refuses none of its writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS org_id uuid
  REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
-- index-build: kernel.apps_installed 200 5
CREATE INDEX IF NOT EXISTS apps_installed_org_id_idx
  ON kernel.apps_installed (org_id) WHERE org_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.apps_active_version 100 5
CREATE INDEX IF NOT EXISTS apps_active_version_org_id_idx
  ON kernel.apps_active_version (org_id) WHERE org_id IS NOT NULL;
