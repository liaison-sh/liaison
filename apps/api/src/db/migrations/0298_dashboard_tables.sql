-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- Dashboard tables: org data people and agents write, with typed columns, their own sharing,
-- history and undo (modules/dashboards/tables).
--
--  - kernel.dashboard_tables: a table's name, columns and sharing, shared exactly as dashboards
--    are (0295): an owner, `org_access` (none | viewer | editor) and kernel.resource_grants rows of
--    type 'kernel.dashboard_table'. Read: its owner, everyone when org_access is viewer or editor,
--    anyone granted. Edit (rows and columns): kernel:dashboards:write AND (its owner, org_access
--    editor, or an editor grant); kernel:dashboards:admin on a table the whole org sees. Delete:
--    its owner, or a dashboards admin on one the whole org sees. No admin bypass of a restricted
--    table. `rows_generation` moves with every row write in the row's own transaction: a cached
--    block read keys on it, so a write can never be shadowed by a cache filled before its commit.
--  - The rows live in kernel.app_documents under app 'dashboards', collection 't_<table id hex>',
--    the cells at the top level of `data`. RESTRICTIVE policies, one per command, make every such
--    row follow its table: SELECT needs the table to be readable, INSERT/UPDATE/DELETE editable.
--    The table check is an uncorrelated subquery that runs under the caller's own RLS on
--    dashboard_tables (as dashboard_versions follows kernel.dashboards), never a cast of the
--    protected `collection` column.
--  - kernel.dashboard_table_changes: one row per row write (create, update, delete, undo) with
--    the cells before and after, who made it (a person, an agent, a routine) and when. Readable
--    with the table, appended by its editors, never updated or deleted under RLS. No foreign key
--    to the table: a deleted table's history stays for retention and export only (no RLS reader
--    sees a table that is gone).
--  - kernel.routines.event_filter: the table-row trigger filter {tableId, column?, to?} joins the
--    mail sender filter (the CHECK is widened, NOT VALID then VALIDATE).
--
-- New tables and a widened CHECK; every statement is re-runnable.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS kernel.dashboard_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  columns jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) <= 40),
  -- Dropped columns: their definitions (labels for history), their keys never reused.
  dropped_columns jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(dropped_columns) = 'array'),
  agent_writes_need_approval boolean NOT NULL DEFAULT false,
  org_access text NOT NULL DEFAULT 'none'
    CONSTRAINT dashboard_tables_org_access_check CHECK (org_access IN ('none', 'viewer', 'editor')),
  acl_user_ids jsonb NOT NULL DEFAULT '[]',
  acl_role_ids jsonb NOT NULL DEFAULT '[]',
  owner_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  rows_generation bigint NOT NULL DEFAULT 0 CHECK (rows_generation >= 0),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_tables_org_name_uidx
  ON kernel.dashboard_tables (org_id, lower(name));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_tables_owner_user_fk_idx
  ON kernel.dashboard_tables (owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_tables_created_by_fk_idx
  ON kernel.dashboard_tables (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_tables_updated_by_fk_idx
  ON kernel.dashboard_tables (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.dashboard_table_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  -- No foreign key on purpose: the history outlives a deleted table (retention, export).
  table_id uuid NOT NULL,
  row_id text NOT NULL CHECK (row_id <> '' AND length(row_id) <= 200),
  op text NOT NULL CHECK (op IN ('create', 'update', 'delete', 'undo')),
  before jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after jsonb CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),
  -- The row's version once this change was written (null: the row was deleted).
  row_version integer,
  -- The change an undo reverted.
  undoes uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  agent_id uuid,
  routine_id uuid,
  approval_id uuid,
  -- An agent's handle or a routine's name as it was at the time (never a person's name).
  actor_label text CHECK (actor_label IS NULL OR char_length(actor_label) <= 200),
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_table_changes_row_idx
  ON kernel.dashboard_table_changes (org_id, table_id, row_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_table_changes_table_idx
  ON kernel.dashboard_table_changes (org_id, table_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_table_changes_actor_fk_idx
  ON kernel.dashboard_table_changes (actor_id) WHERE actor_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dashboard_table_changes_at_idx
  ON kernel.dashboard_table_changes (at);
--> statement-breakpoint

ALTER TABLE kernel.dashboard_tables ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_tables FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_table_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.dashboard_table_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.dashboard_tables TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON kernel.dashboard_table_changes TO liaison_rls, liaison_app;
--> statement-breakpoint

-- May the current actor edit a table with this owner, org access and id (write its rows, change
-- its columns)? SECURITY INVOKER: it reads only the actor's context and the grants (through the
-- definer resource_grant_role), so the policies below share one rule.
-- reviewed-dynamic: a SQL function body over the actor's context, no DDL.
CREATE OR REPLACE FUNCTION kernel.dashboard_table_can_edit(
  p_owner uuid, p_org_access text, p_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = kernel, pg_temp AS $fn$
  SELECT (
      kernel.has_scope('kernel:dashboards:write')
      AND (
        p_owner = NULLIF(rls_ctx.user_id(), '')::uuid
        OR p_org_access = 'editor'
        OR kernel.resource_grant_role('kernel.dashboard_table', p_id) = 'editor'
      )
    )
    OR (p_org_access <> 'none' AND kernel.has_scope('kernel:dashboards:admin'))
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.dashboard_table_can_edit(uuid, text, uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint

-- dashboard_tables: the sharing rules of 0295, on the table's own owner and grants.
DROP POLICY IF EXISTS dashboard_tables_select ON kernel.dashboard_tables;
--> statement-breakpoint
CREATE POLICY dashboard_tables_select ON kernel.dashboard_tables FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR org_access IN ('viewer', 'editor')
      OR kernel.resource_grant_role('kernel.dashboard_table', id) IS NOT NULL
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_tables_insert ON kernel.dashboard_tables;
--> statement-breakpoint
CREATE POLICY dashboard_tables_insert ON kernel.dashboard_tables FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    AND (SELECT kernel.has_scope('kernel:dashboards:write'))
    AND (
      org_access = 'none'
      OR (SELECT kernel.has_scope('kernel:dashboards:share'))
      OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_tables_update ON kernel.dashboard_tables;
--> statement-breakpoint
CREATE POLICY dashboard_tables_update ON kernel.dashboard_tables FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND kernel.dashboard_table_can_edit(owner_user_id, org_access, id)
  )
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND kernel.dashboard_table_can_edit(owner_user_id, org_access, id)
    AND (
      org_access = 'none'
      OR (SELECT kernel.has_scope('kernel:dashboards:share'))
      OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
      OR owner_user_id IS DISTINCT FROM NULLIF((SELECT rls_ctx.user_id()), '')::uuid
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_tables_delete ON kernel.dashboard_tables;
--> statement-breakpoint
CREATE POLICY dashboard_tables_delete ON kernel.dashboard_tables FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND (
      (
        owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (SELECT kernel.has_scope('kernel:dashboards:write'))
      )
      OR (org_access <> 'none' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
--> statement-breakpoint

-- dashboard_table_changes: read with the table, appended by its editors; no UPDATE and no DELETE
-- policy (retention prunes them privileged).
DROP POLICY IF EXISTS dashboard_table_changes_select ON kernel.dashboard_table_changes;
--> statement-breakpoint
CREATE POLICY dashboard_table_changes_select ON kernel.dashboard_table_changes
  FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND table_id IN (SELECT t.id FROM kernel.dashboard_tables t)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS dashboard_table_changes_insert ON kernel.dashboard_table_changes;
--> statement-breakpoint
CREATE POLICY dashboard_table_changes_insert ON kernel.dashboard_table_changes
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
    AND table_id IN (
      SELECT t.id FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint

-- app_documents rows of app 'dashboards' follow their table. RESTRICTIVE: AND-ed with the
-- org-only policies of 0275, so the existing paths (the data tools, the store source, an app's
-- ctx.store) reach no such row unless the caller may read (or, for a write, edit) its table.
-- expand-safe: a new restrictive policy that only narrows rows of app 'dashboards', which the previous release never writes or reads.
DROP POLICY IF EXISTS app_documents_dashboard_tables_select ON kernel.app_documents;
--> statement-breakpoint
-- expand-safe: rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_documents_dashboard_tables_select ON kernel.app_documents
  AS RESTRICTIVE FOR SELECT TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t)
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_documents_dashboard_tables_insert ON kernel.app_documents;
--> statement-breakpoint
-- expand-safe: rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_documents_dashboard_tables_insert ON kernel.app_documents
  AS RESTRICTIVE FOR INSERT TO liaison_rls
  WITH CHECK (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_documents_dashboard_tables_update ON kernel.app_documents;
--> statement-breakpoint
-- expand-safe: rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_documents_dashboard_tables_update ON kernel.app_documents
  AS RESTRICTIVE FOR UPDATE TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  )
  WITH CHECK (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_documents_dashboard_tables_delete ON kernel.app_documents;
--> statement-breakpoint
-- expand-safe: rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_documents_dashboard_tables_delete ON kernel.app_documents
  AS RESTRICTIVE FOR DELETE TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint

-- app_document_usage rows of app 'dashboards' (a table's row count and size) follow their table
-- too: read by its readers, written (the data store's counter, in the row write's transaction) by
-- its editors. Without them any member learns the ids and sizes of tables not shared with them.
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_document_usage_dashboard_tables_select ON kernel.app_document_usage;
--> statement-breakpoint
-- expand-safe: usage rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_document_usage_dashboard_tables_select ON kernel.app_document_usage
  AS RESTRICTIVE FOR SELECT TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t)
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_document_usage_dashboard_tables_insert ON kernel.app_document_usage;
--> statement-breakpoint
-- expand-safe: usage rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_document_usage_dashboard_tables_insert ON kernel.app_document_usage
  AS RESTRICTIVE FOR INSERT TO liaison_rls
  WITH CHECK (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_document_usage_dashboard_tables_update ON kernel.app_document_usage;
--> statement-breakpoint
-- expand-safe: usage rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_document_usage_dashboard_tables_update ON kernel.app_document_usage
  AS RESTRICTIVE FOR UPDATE TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  )
  WITH CHECK (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS app_document_usage_dashboard_tables_delete ON kernel.app_document_usage;
--> statement-breakpoint
-- expand-safe: usage rows of every other app pass unchanged (app <> 'dashboards'); the previous release has no 'dashboards' rows.
CREATE POLICY app_document_usage_dashboard_tables_delete ON kernel.app_document_usage
  AS RESTRICTIVE FOR DELETE TO liaison_rls
  USING (
    app <> 'dashboards'
    OR collection IN (
      SELECT 't_' || replace(t.id::text, '-', '') FROM kernel.dashboard_tables t
       WHERE kernel.dashboard_table_can_edit(t.owner_user_id, t.org_access, t.id)
    )
  );
--> statement-breakpoint

-- Who may change a table's sharing: whoever edits it (or owns it) AND holds kernel:dashboards:share
-- or :admin. SECURITY DEFINER so the grants table's write policy can ask it without recursing.
-- reviewed-dynamic: a SQL function body reading kernel.dashboard_tables, no DDL.
CREATE OR REPLACE FUNCTION kernel.can_manage_dashboard_table_sharing(_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
  SELECT (kernel.has_scope('kernel:dashboards:share') OR kernel.has_scope('kernel:dashboards:admin'))
     AND EXISTS (
       SELECT 1 FROM kernel.dashboard_tables t
        WHERE t.id = _id
          AND t.org_id = NULLIF(rls_ctx.org_id(), '')::uuid
          AND (
            t.owner_user_id = NULLIF(rls_ctx.user_id(), '')::uuid
            OR (t.org_access = 'editor' AND kernel.has_scope('kernel:dashboards:write'))
            OR (kernel.resource_grant_role('kernel.dashboard_table', t.id) = 'editor'
                AND kernel.has_scope('kernel:dashboards:write'))
            OR (t.org_access <> 'none' AND kernel.has_scope('kernel:dashboards:admin'))
          )
     )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_manage_dashboard_table_sharing(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.can_manage_dashboard_table_sharing(uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint
INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
VALUES ('kernel.dashboard_table', 'kernel.can_manage_dashboard_table_sharing(uuid)', 'kernel.dashboard_tables')
ON CONFLICT (resource_type) DO UPDATE
  SET can_manage = EXCLUDED.can_manage, resource_table = EXCLUDED.resource_table;
--> statement-breakpoint

-- The search projection knows dashboard tables (owner column: owner_user_id). Carried forward
-- from 0295 verbatim except the one WHEN line.
-- reviewed-dynamic: the function body is 0295's (its EXECUTE updates the projection columns), unchanged but for the dashboard table case.
-- expand-safe: same signature and behaviour for the previous release's three resource types; it only learns kernel.dashboard_table.
CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(
  p_type text, p_resource_id uuid, p_org uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  -- An untagged context reads as the all-zero org: fall back to p_org as 0178 did for an unset one.
  v_org uuid := COALESCE(NULLIF(NULLIF(rls_ctx.org_id(), ''), '00000000-0000-0000-0000-000000000000')::uuid, p_org);
  v_table regclass;
  v_owner_cols text[];
  v_owner_union text;
BEGIN
  IF p_org IS NOT NULL AND p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'recompute_search_acl: not the transaction''s org' USING ERRCODE = '42501';
  END IF;
  v_owner_cols := CASE p_type
    WHEN 'kernel.contact' THEN ARRAY['owner_user_id']
    WHEN 'knowledge.document' THEN ARRAY['owner_user_id', 'created_by']
    WHEN 'kernel.dashboard' THEN ARRAY['owner_user_id']
    WHEN 'kernel.dashboard_table' THEN ARRAY['owner_user_id']
  END;
  SELECT resource_table INTO v_table
    FROM kernel.shareable_resource_types WHERE resource_type = p_type;
  IF v_owner_cols IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'not a shareable resource type: %', p_type USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(format('SELECT r.%1$I::text AS uid WHERE r.%1$I IS NOT NULL', c), ' UNION ')
    INTO v_owner_union FROM unnest(v_owner_cols) AS c;
  EXECUTE format($q$
    UPDATE %s r
       SET acl_user_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT u.uid), '[]'::jsonb) FROM (
               %s
               UNION
               SELECT g.grantee AS uid FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'user'
             ) u),
           acl_role_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT k.key), '[]'::jsonb) FROM (
               SELECT g.grantee AS key FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'role'
               UNION
               SELECT dk.key
                 FROM kernel.resource_grants g
                 CROSS JOIN LATERAL (
                   SELECT split_part(g.grantee, '=', 1) AS dim,
                          substr(g.grantee, strpos(g.grantee, '=') + 1) AS val
                 ) d
                 CROSS JOIN LATERAL unnest(ARRAY[
                   'dim:' || d.dim || '=' || d.val,
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=' || d.val,
                   'dim:' || d.dim || '=*',
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=*',
                   'dim:*'
                 ]) AS dk(key)
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'dimension'
             ) k)
     WHERE r.id = $2 AND r.org_id = $3
  $q$, v_table, v_owner_union) USING p_type, p_resource_id, v_org;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.recompute_search_acl(text, uuid, uuid) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: the same revoke 0295 ran on this function; the grant below restores the callers.
REVOKE ALL ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.dashboard_tables TO liaison_definer;
--> statement-breakpoint
GRANT UPDATE (acl_user_ids, acl_role_ids) ON kernel.dashboard_tables TO liaison_definer;
--> statement-breakpoint

-- A table-row trigger filter ({tableId, column?, to?}) is valid on the three table-row events.
-- expand-safe: replaced by the wider check below in the same transaction; every row the previous release writes (a mail filter on mail:message:create, or none) satisfies it.
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_event_filter_chk;
--> statement-breakpoint
-- expand-safe: a wider check than the one it replaces; the previous release only writes rows the old check allowed, which this one allows too.
ALTER TABLE kernel.routines ADD CONSTRAINT routines_event_filter_chk CHECK (
  event_filter IS NULL OR (
    jsonb_typeof(event_filter) = 'object'
    AND event IN (
      'mail:message:create',
      'kernel:dashboard_table_row:created',
      'kernel:dashboard_table_row:updated',
      'kernel:dashboard_table_row:deleted'
    )
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE kernel.routines VALIDATE CONSTRAINT routines_event_filter_chk;
