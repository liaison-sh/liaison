-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who made a task's last edit. A status change already names its actor in task_transitions; an
-- edit of another property (a field, the title, the assignee) named no one, so a row that reads
-- tasks (a dashboard table backed by a project) said "System" for a person's edit. updateTask
-- stamps these with the write: the actor type (user, agent, routine), the person the write ran as
-- and the routine that acted, plus when, so a later write by another path that does not stamp
-- them is never misread as this one. NULL = not recorded (older tasks, other write paths).
-- Additive and re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: a new check on a new column the previous release never writes.
ALTER TABLE app_projects.tasks
  ADD COLUMN IF NOT EXISTS updated_by_type text
    CONSTRAINT tasks_updated_by_type_chk
    CHECK (updated_by_type IN ('user', 'agent', 'routine', 'system')),
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by_routine_id uuid,
  ADD COLUMN IF NOT EXISTS updated_by_at timestamptz;
