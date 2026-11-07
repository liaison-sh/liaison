-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The operator's kill switch for an org's custom app (managed edition,
-- modules/cloud/custom-app-disable.ts): a disabled custom app stays installed
-- (its rows, files and data are kept for the incident) but no dispatch path
-- runs it, its owner cannot uninstall or re-install it, until the operator
-- enables it again. NULL = not disabled, as every row was before.
--
-- Additive and nullable, every statement re-runnable: the previous release
-- never reads or writes the columns.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
--> statement-breakpoint
-- expand-safe: a new nullable column the previous release never reads or writes
ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS disabled_reason text;
