-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The Workers module of an org's custom app version, recorded at install from
-- the build the publish pinned (modules/app-builder/publish.ts): its sha256,
-- which the Workers executor names in /run for custom apps instead of a
-- LIAISON_WORKERS_BUNDLES entry (sandbox/run-app.ts), and its bytes, which the
-- cell serves to the app loader on GET /api/app-bridge/bundles/:sha256
-- (workers/bundle-route.ts) when the loader has no copy yet. NULL on every
-- other row (instance apps, catalog apps, custom apps installed by URL). No
-- index: the table holds one row per installed app version.
--
-- Additive and nullable, every statement re-runnable: the previous release
-- never reads or writes the columns.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS worker_sha256 text;
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS worker_module bytea;
--> statement-breakpoint
-- expand-safe: every existing row has both columns NULL, so the check holds
ALTER TABLE kernel.apps_installed DROP CONSTRAINT IF EXISTS apps_installed_worker_module_check;
--> statement-breakpoint
-- expand-safe: every existing row has both columns NULL, so the check holds
ALTER TABLE kernel.apps_installed
  ADD CONSTRAINT apps_installed_worker_module_check CHECK (
    (worker_sha256 IS NULL AND worker_module IS NULL)
    OR (worker_sha256 ~ '^[0-9a-f]{64}$' AND worker_module IS NOT NULL AND org_id IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.apps_installed VALIDATE CONSTRAINT apps_installed_worker_module_check;
