-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Task checklist storage: per-project validation levels (JSONB on the project,
-- read with it) and card-summary option, a free-text release on tasks, and the checklist items table.
-- Additive and idempotent (IF NOT EXISTS, defaults on the new NOT NULL column).

ALTER TABLE app_projects.projects
  ADD COLUMN IF NOT EXISTS validation_levels jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Per-project option: show the checklist summary on Kanban cards (default on).
ALTER TABLE app_projects.projects
  ADD COLUMN IF NOT EXISTS checklist_on_cards boolean NOT NULL DEFAULT true;
ALTER TABLE app_projects.tasks ADD COLUMN IF NOT EXISTS release text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tasks_org_release
  ON app_projects.tasks (org_id, lower(release));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_projects.task_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  position DOUBLE PRECISION NOT NULL DEFAULT 1000,
  title TEXT NOT NULL,
  details TEXT,
  checked BOOLEAN NOT NULL DEFAULT false,
  validations JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.task_checklist_items OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_task_checklist_items_task_position
  ON app_projects.task_checklist_items (task_id, position);
--> statement-breakpoint

ALTER TABLE app_projects.task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_checklist_items FORCE ROW LEVEL SECURITY;

-- Same org predicate as the tasks policies, plus: the item's task exists in
-- the item's org. The column refs are qualified because an unqualified
-- `org_id` inside the subquery would bind to the task row (t.org_id = t.org_id).
DROP POLICY IF EXISTS task_checklist_items_deny_default ON app_projects.task_checklist_items;
DROP POLICY IF EXISTS task_checklist_items_select ON app_projects.task_checklist_items;
DROP POLICY IF EXISTS task_checklist_items_insert ON app_projects.task_checklist_items;
DROP POLICY IF EXISTS task_checklist_items_update ON app_projects.task_checklist_items;
DROP POLICY IF EXISTS task_checklist_items_delete ON app_projects.task_checklist_items;

CREATE POLICY task_checklist_items_deny_default ON app_projects.task_checklist_items
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);

CREATE POLICY task_checklist_items_select ON app_projects.task_checklist_items FOR SELECT TO liaison_rls
  USING (
    task_checklist_items.org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_checklist_items.task_id AND t.org_id = task_checklist_items.org_id
    )
  );
CREATE POLICY task_checklist_items_insert ON app_projects.task_checklist_items FOR INSERT TO liaison_rls
  WITH CHECK (
    task_checklist_items.org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_checklist_items.task_id AND t.org_id = task_checklist_items.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
CREATE POLICY task_checklist_items_update ON app_projects.task_checklist_items FOR UPDATE TO liaison_rls
  USING (
    task_checklist_items.org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_checklist_items.task_id AND t.org_id = task_checklist_items.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  )
  WITH CHECK (
    task_checklist_items.org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_checklist_items.task_id AND t.org_id = task_checklist_items.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
CREATE POLICY task_checklist_items_delete ON app_projects.task_checklist_items FOR DELETE TO liaison_rls
  USING (
    task_checklist_items.org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_checklist_items.task_id AND t.org_id = task_checklist_items.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON app_projects.task_checklist_items
  TO liaison_rls, liaison_app, liaison_admin;
