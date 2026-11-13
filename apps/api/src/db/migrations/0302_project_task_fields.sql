-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Per-project typed task fields and status transitions.
--   projects.task_fields   the project's field definitions (dashboard column shape, plus
--                          `removed: true` tombstones for definitions taken off the project)
--   tasks.fields           a task's values {key: cell}
--   tasks.status_entered_at when the task entered its current status
--   task_transitions       every status change (append-only): from, to, actor, at, and `seq`,
--                          the order of rows that share one `at` (one transaction's changes)
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
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.task_transitions OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_task_transitions_task_at
  ON app_projects.task_transitions (task_id, "at" DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_task_transitions_project_to_at
  ON app_projects.task_transitions (project_id, to_status_id, "at");
--> statement-breakpoint

ALTER TABLE app_projects.task_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_transitions FORCE ROW LEVEL SECURITY;

-- Readable by who can read the task, written by who can write tasks; never changed or removed.
-- App registration also generates the permissive `task_transitions_rls_*` policies (scope only,
-- passed by `*`, `projects` and `projects:*`) and grants UPDATE and DELETE on every table of the
-- schema. Permissive policies OR together, so the rules here are RESTRICTIVE: they hold whatever
-- else is granted. The erasure (anonymize actor_id) and the task-delete cascade do not run as
-- liaison_rls (a privileged role; a foreign-key action bypasses RLS), so they still apply.
DROP POLICY IF EXISTS task_transitions_deny_default ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_select ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_insert ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_follow_task ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_insert_scope ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_no_update ON app_projects.task_transitions;
DROP POLICY IF EXISTS task_transitions_no_delete ON app_projects.task_transitions;

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
-- Restrictive: every read and write, whatever policy let it in, follows the task.
CREATE POLICY task_transitions_follow_task ON app_projects.task_transitions
  AS RESTRICTIVE FOR ALL TO liaison_rls
  USING (
    task_transitions.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_transitions.task_id AND t.org_id = task_transitions.org_id
    )
  )
  WITH CHECK (
    task_transitions.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_transitions.task_id AND t.org_id = task_transitions.org_id
    )
  );
CREATE POLICY task_transitions_insert_scope ON app_projects.task_transitions
  AS RESTRICTIVE FOR INSERT TO liaison_rls
  WITH CHECK (app_projects.app_has_scope('projects:tasks:write'));
-- Append-only: no row is ever changed or removed under RLS.
CREATE POLICY task_transitions_no_update ON app_projects.task_transitions
  AS RESTRICTIVE FOR UPDATE TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY task_transitions_no_delete ON app_projects.task_transitions
  AS RESTRICTIVE FOR DELETE TO liaison_rls USING (false);
--> statement-breakpoint

GRANT SELECT, INSERT, REFERENCES ON app_projects.task_transitions
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint

-- When each existing task entered its current status: the first task event that carried the
-- current status after the last one that carried another (the audit log keeps every task event's
-- data, statusId included). A task with no such event entered it when it was created.
-- One pass: the task events are joined to their tasks once (hash join), then grouped per task
-- twice; no correlated subquery, so the cost grows with tasks + events, not their product.
WITH pending AS (
  SELECT t.id, t.org_id, t.status_id::text AS status_id
  FROM app_projects.tasks t
  WHERE NOT EXISTS (SELECT 1 FROM app_projects.task_transitions x WHERE x.task_id = t.id)
),
ev AS MATERIALIZED (
  SELECT p.id AS task_id, al."timestamp" AS at,
         (al.changes->>'statusId') IS NOT DISTINCT FROM p.status_id AS is_current
  FROM kernel.audit_log al
  JOIN pending p ON p.org_id = al.org_id AND p.id::text = al.entity_id
  WHERE al.app = 'projects' AND al.entity_type = 'task'
    AND al.action IN ('task.created', 'task.updated', 'task.moved')
    AND al.changes ? 'statusId'
),
last_other AS (
  SELECT task_id, max(at) AS at FROM ev WHERE NOT is_current GROUP BY task_id
),
entered AS (
  SELECT e.task_id, min(e.at) AS at
  FROM ev e LEFT JOIN last_other l ON l.task_id = e.task_id
  WHERE e.is_current AND e.at > COALESCE(l.at, '-infinity'::timestamptz)
  GROUP BY e.task_id
)
UPDATE app_projects.tasks t
SET status_entered_at = COALESCE(en.at, t.created_at)
FROM pending p LEFT JOIN entered en ON en.task_id = p.id
WHERE t.id = p.id;
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
