-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A dashboard table may be backed by a project (dashboards/tables/backing.ts): its rows are the
-- project's tasks the reader can read, chosen task fields read through, and the table's own
-- columns stored per task id as today. Null = a plain table, unchanged.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.dashboard_tables ADD COLUMN IF NOT EXISTS backing jsonb;
