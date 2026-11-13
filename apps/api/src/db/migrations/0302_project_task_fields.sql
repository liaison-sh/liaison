-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-project typed task fields and status transitions.
--   projects.task_fields   the project's field definitions (dashboard column shape, plus
--                          `removed: true` tombstones for definitions taken off the project)
--   tasks.fields           a task's values {key: cell}
--   tasks.status_entered_at when the task entered its current status
--   task_transitions       every status change (append-only): from, to, actor, at
-- Additive and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE app_projects.projects
  ADD COLUMN IF NOT EXISTS task_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app_projects.tasks
  ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}'::jsonb;
-- now() is a placeholder the backfill below replaces; new rows get the insert time.
ALTER TABLE app_projects.tasks
  ADD COLUMN IF NOT EXISTS status_entered_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_projects.task_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  from_status_id UUID,
  to_status_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'routine', 'system')),
  actor_id UUID,
  agent_id UUID,
  routine_id UUID,
  "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.task_transitions OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_task_transitions_task_at
  ON app_projects.task_transitions (task_id, "at" DESC);
CREATE INDEX IF NOT EXISTS idx_task_transitions_project_to_at
  ON app_projects.task_transitions (project_id, to_status_id, "at");
--> statement-breakpoint

ALTER TABLE app_projects.task_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_transitions FORCE ROW LEVEL SECURITY;

-- Readable by who can read the task, written by who can write tasks; never changed or
-- removed (append-only: no update or delete policy, so the deny default refuses both).
DROP POLICY IF EXISTS task_transitions_deny_default ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_select ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_insert ON app_projects.task_transitions;

CREATE POLICY task_transitions_deny_default ON app_projects.task_transitions
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
-- A transition is readable exactly when its task is: the subquery runs under the tasks' own RLS.
-- The column refs are qualified because an unqualified `org_id` inside the subquery would bind
-- to the task row.
CREATE POLICY task_transitions_select ON app_projects.task_transitions FOR SELECT TO liaison_rls
  USING (
    task_transitions.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_transitions.task_id AND t.org_id = task_transitions.org_id
    )
  );
CREATE POLICY task_transitions_insert ON app_projects.task_transitions FOR INSERT TO liaison_rls
  WITH CHECK (
    task_transitions.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_transitions.task_id AND t.org_id = task_transitions.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
--> statement-breakpoint

GRANT SELECT, INSERT, REFERENCES ON app_projects.task_transitions
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint

-- When each existing task entered its current status: the first task event that carried the
-- current status after the last one that carried another (the audit log keeps every task event's
-- data, statusId included). A task with no such event entered it when it was created.
WITH ev AS (
  SELECT al.org_id, al.entity_id, al."timestamp" AS at, al.changes->>'statusId' AS status_id
  FROM kernel.audit_log al
  WHERE al.app = 'projects' AND al.entity_type = 'task'
    AND al.action IN ('task.created', 'task.updated', 'task.moved')
    AND al.changes ? 'statusId'
)
UPDATE app_projects.tasks t
SET status_entered_at = COALESCE(
  (
    SELECT min(e.at) FROM ev e
    WHERE e.org_id = t.org_id AND e.entity_id = t.id::text AND e.status_id = t.status_id::text
      AND e.at > COALESCE(
        (
          SELECT max(e2.at) FROM ev e2
          WHERE e2.org_id = t.org_id AND e2.entity_id = t.id::text
            AND e2.status_id IS DISTINCT FROM t.status_id::text
        ),
        '-infinity'::timestamptz
      )
  ),
  t.created_at
)
WHERE NOT EXISTS (SELECT 1 FROM app_projects.task_transitions x WHERE x.task_id = t.id);
--> statement-breakpoint

-- One transition per existing task: how it entered its current status, so the time in status
-- and the transition list agree from the start.
INSERT INTO app_projects.task_transitions
  (org_id, project_id, task_id, from_status_id, to_status_id, actor_type, "at")
SELECT t.org_id, t.project_id, t.id, NULL, t.status_id, 'system', t.status_entered_at
FROM app_projects.tasks t
WHERE NOT EXISTS (
  SELECT 1 FROM app_projects.task_transitions x WHERE x.task_id = t.id
);
