-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Repair per-project task-number counters. Cross-project moves used to keep each
-- moved task's number without touching the destination's next_task_number, so a
-- project could hold numbers at or above its counter and every later
-- allocate_task_number call returned a number already taken (unique conflict on
-- app_projects_tasks_number_uidx). Moves now allocate from the destination
-- counter; this raises any lagging counter to one past the highest number held.
-- A counter already ahead (numbers freed by deletes or moves out) is left alone.
-- Idempotent: a second run finds nothing to raise.
UPDATE app_projects.projects p
SET next_task_number = m.max_number + 1
FROM (
  SELECT project_id, max(number) AS max_number
  FROM app_projects.tasks
  GROUP BY project_id
) m
WHERE m.project_id = p.id
  AND p.next_task_number <= m.max_number;
