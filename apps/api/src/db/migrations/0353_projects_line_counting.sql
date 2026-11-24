-- SPDX-License-Identifier: FSL-1.1-ALv2
-- How a reconcile line was drawn, and what its bill leaves out.
--
-- A line of later time, or one the card drew by itself; the minutes of its plan worked inside a
-- retainer's fee or billed elsewhere; the minutes inside work billed at its plan; and the minutes
-- billed and taken off their task since, which come off this line once.
--
-- Forward only, no backfill: an existing line reads null.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads or writes this column
ALTER TABLE app_projects.reconciliation_lines ADD COLUMN counting jsonb;
