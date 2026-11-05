-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The `schema` each installed app version's manifest declared, recorded at
-- install. The additive data rule checks a new version against it when the
-- running version's files are gone from the install root (a container whose
-- install root was not kept), instead of skipping the check. Nullable: rows
-- installed before this migration have none, and code from the previous
-- release, which never writes it, keeps working during a rolling deploy.
-- A catalog-only table, but every app read queues behind an ALTER waiting
-- for a long transaction: fail fast and retry the deploy instead.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kernel"."apps_installed" ADD COLUMN IF NOT EXISTS "manifest_schema" jsonb;
