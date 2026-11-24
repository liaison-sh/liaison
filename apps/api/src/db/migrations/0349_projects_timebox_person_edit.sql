-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A person's edit of a retainer month's timebox outlives the daily roll.
--
-- A retainer's months are written by its schedule (source 'retainer'), and the daily roll writes
-- next month's hours again every day. A person who changed that month's timebox on the project
-- lost the change the next day. Two columns on project_timeboxes:
--   person_edited_at  when a person last set this period's timebox by hand (null: never, or a
--                     newer retainer figure replaced it);
--   source_minutes    the hours the retainer last asked for this period.
-- A retainer write replaces a person's edit only when it brings a figure different from the one
-- it last asked for (its terms changed: the newer act wins); the daily roll repeating the same
-- figure keeps the person's hours.
--
-- Forward only. Existing retainer rows take their own minutes as the retainer's last figure; no
-- existing row carries a person's mark (none was recorded before).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE app_projects.project_timeboxes
  ADD COLUMN person_edited_at timestamptz,
  ADD COLUMN source_minutes integer;
--> statement-breakpoint
UPDATE app_projects.project_timeboxes SET source_minutes = minutes WHERE source = 'retainer';
