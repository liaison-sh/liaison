-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Work closed in a period after that period was invoiced, billed on the next card.
--
-- A period can be invoiced before it ends. What is closed in it afterwards is listed on the next
-- card, and on a retainer the hours worked in that month afterwards are billed as that month's.
-- Three columns record what that needs:
--   reconciliations.excluded_task_ids   the tasks left out of a card as the client's own work, so
--                                       they are never offered as work nobody billed (null: a card
--                                       made before this column, where only their count is known);
--   reconciliation_lines.work_month     the earlier retainer month a line's hours were worked in
--                                       (null: the card's own period);
--   billing_claims.day_minutes          a retainer task's time on the day it was claimed, so only
--                                       the time entered after the claim counts as worked later.
--
-- Forward only, no backfill: an existing card, line or claim reads null.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads these columns; null means what it means today
ALTER TABLE app_projects.reconciliations
  ADD COLUMN excluded_task_ids uuid[];
--> statement-breakpoint
-- expand-safe: the previous release never reads this column, and null passes its check
ALTER TABLE app_projects.reconciliation_lines
  ADD COLUMN work_month text
    CONSTRAINT reconciliation_lines_work_month_format CHECK (work_month ~ '^[0-9]{4}-[0-9]{2}$');
--> statement-breakpoint
-- expand-safe: the previous release never reads this column, and null passes its check
ALTER TABLE app_projects.billing_claims
  ADD COLUMN day_minutes integer
    CONSTRAINT billing_claims_day_minutes_not_negative CHECK (day_minutes >= 0);
