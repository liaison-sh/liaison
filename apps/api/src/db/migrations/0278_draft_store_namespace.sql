-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- The app builder's preview namespace in the app data store: a draft preview's
-- ctx.store writes land in `draft:<draftId>` (modules/app-builder/preview.ts),
-- never in an app's collections. The ':' never occurs in an app name, so the
-- namespace cannot collide with one. kernel.app_documents.app accepts it beside
-- the app names it accepted before (a widened CHECK: every existing row still
-- matches). Re-runnable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: only widens the allowed app values; the check is added back below
ALTER TABLE kernel.app_documents DROP CONSTRAINT IF EXISTS app_documents_app_check;
--> statement-breakpoint
-- expand-safe: every app value the previous release writes is still allowed
ALTER TABLE kernel.app_documents
  ADD CONSTRAINT app_documents_app_check CHECK (
    app ~ '^[a-z][a-z0-9_-]{0,62}$'
    OR app ~ '^draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.app_documents VALIDATE CONSTRAINT app_documents_app_check;
