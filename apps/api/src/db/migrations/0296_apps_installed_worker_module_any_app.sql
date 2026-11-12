-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Every `.liaisonapp` now carries its Worker module (worker.js beside
-- bundle.js), and every install records it (modules/apps/install-service.ts):
-- a catalog app and an uploaded instance app (org_id NULL) as well as an org's
-- custom app. The check of 0279 required org_id for a recorded module; it now
-- holds for any row. Both columns stay NULL together for a version whose
-- package had no worker.js (it runs on QuickJS).
--
-- Expand-safe: the new check is weaker than the old one (every row that held
-- the old check holds this one), and the previous release only ever writes
-- the columns for an org's custom app.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: replaced by a weaker check below, in the same transaction
ALTER TABLE kernel.apps_installed DROP CONSTRAINT IF EXISTS apps_installed_worker_module_check;
--> statement-breakpoint
-- expand-safe: weaker than the check it replaces, so every existing row holds it
ALTER TABLE kernel.apps_installed
  ADD CONSTRAINT apps_installed_worker_module_check CHECK (
    (worker_sha256 IS NULL AND worker_module IS NULL)
    OR (worker_sha256 ~ '^[0-9a-f]{64}$' AND worker_module IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.apps_installed VALIDATE CONSTRAINT apps_installed_worker_module_check;
