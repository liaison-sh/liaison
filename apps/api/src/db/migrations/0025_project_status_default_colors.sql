-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Default project statuses used to seed with color NULL, so every status pill
-- and kanban column rendered the grey UI fallback. New projects now seed with
-- explicit colors (DEFAULT_STATUS_SEEDS in service/create-project.ts — keep the
-- mapping below in sync with it); this backfills existing colorless rows by
-- lowercase label. Unknown labels stay NULL (the CASE yields NULL, and the
-- WHERE label filter skips them entirely so nothing else is touched).
UPDATE app_projects.project_statuses
SET color = CASE lower(label)
  WHEN 'backlog' THEN '#6b7280'
  WHEN 'todo' THEN '#3b82f6'
  WHEN 'in_progress' THEN '#f59e0b'
  WHEN 'done' THEN '#22c55e'
  WHEN 'cancelled' THEN '#ef4444'
END
WHERE color IS NULL
  AND lower(label) IN ('backlog', 'todo', 'in_progress', 'done', 'cancelled');
