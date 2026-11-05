-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Task labels on project tasks: an org-wide two-level taxonomy (group > value) and the
-- per-task assignment of one value per group.
--
-- app_projects.labels holds groups (parent_id NULL) and values (parent_id = a
-- group). A stored node's parent never changes, and a value's parent must be a
-- group of the same org: the labels_parent_guard trigger enforces both, so the
-- tree stays two levels deep on every write. No hard delete: archive stamps
-- archived_at (the table has no DELETE policy and no DELETE grant).
--
-- app_projects.task_labels holds (task, group, value), unique per (org, task,
-- group). The composite FK (value_id, group_id, org_id) -> labels (id,
-- parent_id, org_id) proves the value belongs to the group and the org.
--
-- RLS: labels are read with projects:projects:read and written with
-- projects:labels:admin; assignments are read with projects:projects:read (the
-- tasks_select scope, so labels are visible exactly when the task is) and
-- written with projects:tasks:write, each also requiring the task in the same
-- org. Re-runnable.
--
-- Idempotent on purpose: a database that already holds these tables from an
-- earlier copy of this migration (a fork that shipped it under another number)
-- converges here without error. Tables, indexes and constraints use IF NOT
-- EXISTS, the trigger and the policies are dropped and recreated, and grants
-- repeat harmlessly.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_projects.labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_id UUID NULL REFERENCES app_projects.labels(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ NULL,
  CONSTRAINT labels_id_parent_org_key UNIQUE (id, parent_id, org_id)
);
--> statement-breakpoint

ALTER TABLE app_projects.labels OWNER TO liaison_admin;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_app_projects_labels_parent_id_sort_order
  ON app_projects.labels (org_id, parent_id, sort_order);
--> statement-breakpoint

-- Parent guard. Dynamic SQL on TG_TABLE_SCHEMA so worker-prefixed schemas
-- read their own labels table. These messages are a last line of defence: the
-- service refuses every such case first with a typed error.
-- reviewed-dynamic: trigger body reads the parent row through format(%I) on TG_TABLE_SCHEMA; no DDL
CREATE OR REPLACE FUNCTION app_projects.labels_parent_guard_fn() RETURNS TRIGGER AS $TRIGGER_BODY$
DECLARE
  _ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      RAISE EXCEPTION 'label_parent_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.labels p WHERE p.id = $1 AND p.org_id = $2 AND p.parent_id IS NULL)',
      TG_TABLE_SCHEMA
    ) INTO _ok USING NEW.parent_id, NEW.org_id;
    IF NOT _ok THEN
      RAISE EXCEPTION 'label_depth_limit';
    END IF;
  END IF;
  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint

ALTER FUNCTION app_projects.labels_parent_guard_fn() OWNER TO liaison_admin;
--> statement-breakpoint

DROP TRIGGER IF EXISTS labels_parent_guard ON app_projects.labels;
--> statement-breakpoint

CREATE TRIGGER labels_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id ON app_projects.labels
  FOR EACH ROW EXECUTE FUNCTION app_projects.labels_parent_guard_fn();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_projects.task_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id UUID NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES app_projects.labels(id) ON DELETE RESTRICT,
  value_id UUID NOT NULL,
  UNIQUE (org_id, task_id, group_id),
  CONSTRAINT task_labels_value_in_group_fk FOREIGN KEY (value_id, group_id, org_id)
    REFERENCES app_projects.labels (id, parent_id, org_id) ON DELETE RESTRICT
);
--> statement-breakpoint

ALTER TABLE app_projects.task_labels OWNER TO liaison_admin;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_app_projects_task_labels_group_id_value_id
  ON app_projects.task_labels (org_id, group_id, value_id);
--> statement-breakpoint

ALTER TABLE app_projects.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.labels FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS labels_deny_default ON app_projects.labels;
DROP POLICY IF EXISTS labels_select ON app_projects.labels;
DROP POLICY IF EXISTS labels_insert ON app_projects.labels;
DROP POLICY IF EXISTS labels_update ON app_projects.labels;

CREATE POLICY labels_deny_default ON app_projects.labels
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);

CREATE POLICY labels_select ON app_projects.labels FOR SELECT TO liaison_rls
  USING (
    labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:projects:read')
  );
CREATE POLICY labels_insert ON app_projects.labels FOR INSERT TO liaison_rls
  WITH CHECK (
    labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:labels:admin')
  );
CREATE POLICY labels_update ON app_projects.labels FOR UPDATE TO liaison_rls
  USING (
    labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:labels:admin')
  )
  WITH CHECK (
    labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_projects.app_has_scope('projects:labels:admin')
  );
--> statement-breakpoint

ALTER TABLE app_projects.task_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_labels FORCE ROW LEVEL SECURITY;

-- Column refs are qualified because an unqualified `org_id` inside the
-- subquery would bind to the task row (t.org_id = t.org_id).
DROP POLICY IF EXISTS task_labels_deny_default ON app_projects.task_labels;
DROP POLICY IF EXISTS task_labels_select ON app_projects.task_labels;
DROP POLICY IF EXISTS task_labels_insert ON app_projects.task_labels;
DROP POLICY IF EXISTS task_labels_update ON app_projects.task_labels;
DROP POLICY IF EXISTS task_labels_delete ON app_projects.task_labels;

CREATE POLICY task_labels_deny_default ON app_projects.task_labels
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);

CREATE POLICY task_labels_select ON app_projects.task_labels FOR SELECT TO liaison_rls
  USING (
    task_labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_labels.task_id AND t.org_id = task_labels.org_id
    )
    AND app_projects.app_has_scope('projects:projects:read')
  );
CREATE POLICY task_labels_insert ON app_projects.task_labels FOR INSERT TO liaison_rls
  WITH CHECK (
    task_labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_labels.task_id AND t.org_id = task_labels.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
CREATE POLICY task_labels_update ON app_projects.task_labels FOR UPDATE TO liaison_rls
  USING (
    task_labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_labels.task_id AND t.org_id = task_labels.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  )
  WITH CHECK (
    task_labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_labels.task_id AND t.org_id = task_labels.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
CREATE POLICY task_labels_delete ON app_projects.task_labels FOR DELETE TO liaison_rls
  USING (
    task_labels.org_id = (SELECT rls_ctx.org_id())::uuid
    AND EXISTS (
      SELECT 1 FROM app_projects.tasks t
      WHERE t.id = task_labels.task_id AND t.org_id = task_labels.org_id
    )
    AND app_projects.app_has_scope('projects:tasks:write')
  );
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, REFERENCES ON app_projects.labels
  TO liaison_rls, liaison_app, liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON app_projects.task_labels
  TO liaison_rls, liaison_app, liaison_admin;
