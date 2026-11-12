-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- Dashboards adopt the generic, Drive-style sharing that Knowledge documents and contacts use
-- (0117, modules/sharing): `org_access` ('none' | 'viewer' | 'editor', what every member of the
-- org gets) plus kernel.resource_grants rows of type 'kernel.dashboard' (a person or a role, as
-- viewer or editor). A dashboard restricted to some people or roles (a management dashboard) is
-- invisible to everyone else by every path: the row policies below, and every table that follows
-- them (dashboard_versions, dashboard_viewer_states: their policies read kernel.dashboards under
-- the caller's own RLS, so they need no change).
--
-- Today's states map without a change of behaviour: personal = 'none' and no grant (its owner
-- only); org = 'viewer' (everyone reads it; its owner and the dashboards admins edit it).
--
-- Who does what:
--   read:   its owner, everyone when org_access is viewer or editor, anyone granted (any role).
--   edit:   its owner; a holder of kernel:dashboards:write when org_access is editor or they hold
--           an editor grant; a holder of kernel:dashboards:admin on a dashboard the whole org can
--           see (as before). NO admin bypass of a restricted dashboard.
--   delete: its owner, or a dashboards admin on one the whole org can see (as before).
--   share:  whoever edits it AND holds kernel:dashboards:share or :admin
--           (kernel.can_manage_dashboard_sharing, the grants table's write policy).
--
-- Expand/contract: `visibility` stays, derived from org_access by a trigger ('org' iff org_access
-- is not 'none'), so the previous release reads it as before; a write from that release that sets
-- only `visibility` sets org_access from it (personal -> none, org -> viewer). Every statement is
-- re-runnable.

SET LOCAL lock_timeout = '5s';

-- expand-safe: a new nullable column, filled by the trigger below on every write, backfilled here.
ALTER TABLE kernel.dashboards
  ADD COLUMN IF NOT EXISTS org_access text
    CONSTRAINT dashboards_org_access_check CHECK (org_access IN ('none', 'viewer', 'editor'));
--> statement-breakpoint
-- expand-safe: the search projection every shareable resource carries (recompute_search_acl);
-- constant defaults, no table rewrite.
ALTER TABLE kernel.dashboards
  ADD COLUMN IF NOT EXISTS acl_user_ids jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS acl_role_ids jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE kernel.dashboards
   SET org_access = CASE WHEN visibility = 'org' THEN 'viewer' ELSE 'none' END
 WHERE org_access IS NULL;
--> statement-breakpoint
UPDATE kernel.dashboards
   SET acl_user_ids = jsonb_build_array(owner_user_id::text)
 WHERE owner_user_id IS NOT NULL AND acl_user_ids = '[]'::jsonb;
--> statement-breakpoint

-- org_access is the truth; visibility follows it. A write that names only visibility (the
-- previous release) moves org_access with it.
-- reviewed-dynamic: a plain trigger body that sets two columns of the row, no DDL.
CREATE OR REPLACE FUNCTION kernel.dashboards_sync_access() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.org_access IS NULL THEN
      NEW.org_access := CASE WHEN NEW.visibility = 'org' THEN 'viewer' ELSE 'none' END;
    END IF;
  ELSIF NEW.org_access IS NOT DISTINCT FROM OLD.org_access
        AND NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    NEW.org_access := CASE WHEN NEW.visibility = 'org' THEN 'viewer' ELSE 'none' END;
  END IF;
  NEW.visibility := CASE WHEN NEW.org_access = 'none' THEN 'personal' ELSE 'org' END;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.dashboards_sync_access() TO liaison_rls, liaison_app;
--> statement-breakpoint
-- expand-safe: the trigger is new in this file; the drop only makes the file re-runnable.
DROP TRIGGER IF EXISTS dashboards_sync_access ON kernel.dashboards;
--> statement-breakpoint
-- expand-safe: the previous release's writes keep their meaning: it names only visibility, and the trigger sets org_access from it (personal = none, org = viewer).
CREATE TRIGGER dashboards_sync_access
  BEFORE INSERT OR UPDATE ON kernel.dashboards
  FOR EACH ROW EXECUTE FUNCTION kernel.dashboards_sync_access();
--> statement-breakpoint
-- org_access stays nullable in the catalog (SET NOT NULL is a contract change): every row was
-- backfilled above and the trigger fills every write, so no row ever holds NULL.

-- May the current actor edit the dashboard (the UPDATE policy's USING, in one place)? SECURITY
-- DEFINER so the grants table's write policy can ask it without recursing into the dashboards
-- policies; it reads only the actor's context and pins the org.
-- reviewed-dynamic: a SQL function body reading kernel.dashboards, no DDL.
CREATE OR REPLACE FUNCTION kernel.can_manage_dashboard_sharing(_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kernel, pg_temp AS $fn$
  SELECT (kernel.has_scope('kernel:dashboards:share') OR kernel.has_scope('kernel:dashboards:admin'))
     AND EXISTS (
       SELECT 1 FROM kernel.dashboards d
        WHERE d.id = _id
          AND d.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND (
            d.owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            OR (d.org_access = 'editor' AND kernel.has_scope('kernel:dashboards:write'))
            OR (kernel.resource_grant_role('kernel.dashboard', d.id) = 'editor'
                AND kernel.has_scope('kernel:dashboards:write'))
            OR (d.org_access <> 'none' AND kernel.has_scope('kernel:dashboards:admin'))
          )
     )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_manage_dashboard_sharing(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.can_manage_dashboard_sharing(uuid) TO liaison_rls, liaison_app;
--> statement-breakpoint
INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
VALUES ('kernel.dashboard', 'kernel.can_manage_dashboard_sharing(uuid)', 'kernel.dashboards')
ON CONFLICT (resource_type) DO UPDATE
  SET can_manage = EXCLUDED.can_manage, resource_table = EXCLUDED.resource_table;
--> statement-breakpoint

-- The search projection now knows dashboards (owner column: owner_user_id). Carried forward from
-- 0178 verbatim except the one WHEN line.
-- reviewed-dynamic: the function body is 0178's (its EXECUTE updates the projection columns), unchanged but for the dashboards case.
-- expand-safe: same signature and behaviour for the previous release's two resource types; it only learns kernel.dashboard.
CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(
  p_type text, p_resource_id uuid, p_org uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := COALESCE(NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_org);
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
REVOKE ALL ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on a function this file defines, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.recompute_search_acl(text, uuid, uuid) TO liaison_rls, liaison_admin;
--> statement-breakpoint
GRANT SELECT ON kernel.dashboards TO liaison_definer;
--> statement-breakpoint
GRANT UPDATE (acl_user_ids, acl_role_ids) ON kernel.dashboards TO liaison_definer;
--> statement-breakpoint

-- The row policies. The user is compared by casting the context value, never the column (0253).
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS dashboards_select ON kernel.dashboards;
--> statement-breakpoint
-- expand-safe: reads the same rows as before for every dashboard the previous release can create (personal = owner, org = everyone); only a dashboard shared through grants, which that release cannot make, gains readers.
CREATE POLICY dashboards_select ON kernel.dashboards FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR org_access IN ('viewer', 'editor')
      OR kernel.resource_grant_role('kernel.dashboard', id) IS NOT NULL
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS dashboards_insert ON kernel.dashboards;
--> statement-breakpoint
-- expand-safe: the same rule as before, written on org_access, which the trigger derives from the visibility the previous release sends.
CREATE POLICY dashboards_insert ON kernel.dashboards FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (
        owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          org_access = 'none'
          OR (SELECT kernel.has_scope('kernel:dashboards:share'))
          OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
        )
      )
      OR (org_access <> 'none' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS dashboards_update ON kernel.dashboards;
--> statement-breakpoint
-- expand-safe: the owner and the admins of org dashboards keep exactly their rights; only editors granted by this release's sharing gain a write.
CREATE POLICY dashboards_update ON kernel.dashboards FOR UPDATE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR (
        (SELECT kernel.has_scope('kernel:dashboards:write'))
        AND (
          org_access = 'editor'
          OR kernel.resource_grant_role('kernel.dashboard', id) = 'editor'
        )
      )
      OR (org_access <> 'none' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (
        owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
        AND (
          org_access = 'none'
          OR (SELECT kernel.has_scope('kernel:dashboards:share'))
          OR (SELECT kernel.has_scope('kernel:dashboards:admin'))
        )
      )
      OR (
        (SELECT kernel.has_scope('kernel:dashboards:write'))
        AND (
          org_access = 'editor'
          OR kernel.resource_grant_role('kernel.dashboard', id) = 'editor'
        )
      )
      OR (org_access <> 'none' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
--> statement-breakpoint
-- expand-safe: replaced by the policy below in the same transaction.
DROP POLICY IF EXISTS dashboards_delete ON kernel.dashboards;
--> statement-breakpoint
-- expand-safe: the same rule as before (owner, or a dashboards admin on an org dashboard), written on org_access.
CREATE POLICY dashboards_delete ON kernel.dashboards FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      owner_user_id = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
      OR (org_access <> 'none' AND (SELECT kernel.has_scope('kernel:dashboards:admin')))
    )
  );
