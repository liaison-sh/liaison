-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who may use a restricted app, in SQL (S20, A3, A24-4, D20).
--
-- `kernel.app_access_denied(org, user, app)` is true when the app is
-- restricted in the workspace (`kernel.apps.access_mode = 'restricted'`) and
-- the person neither holds `*` nor is listed in `kernel.org_app_access`,
-- directly or through a role they hold. It is the SQL twin of
-- `restrictedAppsDeniedTo` (modules/permissions/permissions.ts), which drops
-- the app's scopes at effective-scope resolution: every reader that bypasses
-- the session's scopes by reading the grant tables directly calls it, so a
-- grant the token no longer carries cannot reach the app's data another way.
--
-- Readers: the notified-approver branch of `approval_requests_select` (below),
-- `eligibleApprovers` (modules/permissions/eligible-approvers.ts) and the
-- requester-decides check of the approvals attention provider. The shared
-- ticket and mail branches of the policy read the session scopes
-- (`app_has_scope`), already filtered.
--
-- SECURITY INVOKER and STABLE: every caller already reads these tables for the
-- same org (the policy under the request's org, the others on the privileged
-- login). `p_app` may be an app name (`mcp-manager`, from a tool name) or a
-- scope prefix (`mcp_manager`, from a scope): both spellings match. Re-runnable.
CREATE OR REPLACE FUNCTION kernel.app_access_denied(p_org uuid, p_user uuid, p_app text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT EXISTS (
      SELECT 1 FROM kernel.apps a
       WHERE a.org_id = p_org AND replace(a.name, '-', '_') = replace(p_app, '-', '_')
         AND a.access_mode = 'restricted'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.user_scope_grants g
       WHERE g.org_id = p_org AND g.user_id = p_user AND g.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.user_roles ur
        JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
       WHERE ur.org_id = p_org AND ur.user_id = p_user AND rsg.scope = '*'
    )
    AND NOT EXISTS (
      SELECT 1 FROM kernel.org_app_access x
       WHERE x.org_id = p_org AND replace(x.app, '-', '_') = replace(p_app, '-', '_')
         AND (
           (x.principal_type = 'user' AND x.principal_id = p_user)
           OR (x.principal_type = 'role' AND x.principal_id IN (
             SELECT ur.role_id FROM kernel.user_roles ur
              WHERE ur.org_id = p_org AND ur.user_id = p_user
           ))
         )
    )
$fn$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kernel.app_access_denied(uuid, uuid, text) TO PUBLIC;
--> statement-breakpoint
-- The notified-approver branch now also requires the reader to keep the app.
-- Everything else is the policy as it stands after 0186 (rls_ctx readers),
-- unchanged. Idempotent (DROP IF EXISTS, then CREATE).
DROP POLICY IF EXISTS approval_requests_select ON kernel.approval_requests;
--> statement-breakpoint
CREATE POLICY approval_requests_select ON kernel.approval_requests FOR SELECT TO liaison_rls
  USING (
((org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND (((resource_owner_id IS NOT NULL) AND ((requested_by = (NULLIF(( SELECT rls_ctx.user_id() AS user_id), ''::text))::uuid) OR (resource_owner_id = (NULLIF(( SELECT rls_ctx.user_id() AS user_id), ''::text))::uuid))) OR ((resource_owner_id IS NULL) AND ((requested_by = (( SELECT rls_ctx.user_id() AS user_id))::uuid) OR (EXISTS ( SELECT 1
   FROM ( VALUES ('kernel:approvals:admin'::text), ('kernel:users:admin'::text)) required(scope)
  WHERE ((EXISTS ( SELECT 1
           FROM kernel.user_scope_grants g
          WHERE ((g.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (g.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((g.scope = '*'::text) OR (g.scope = required.scope) OR ("left"(required.scope, (length(g.scope) + 1)) = (g.scope || ':'::text)) OR (("right"(g.scope, 2) = ':*'::text) AND (strpos("left"(g.scope, (length(g.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(g.scope) - 1)) = "left"(g.scope, (length(g.scope) - 1)))))))) OR (EXISTS ( SELECT 1
           FROM (kernel.user_roles ur
             JOIN kernel.role_scope_grants rsg ON ((rsg.role_id = ur.role_id)))
          WHERE ((ur.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (ur.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((rsg.scope = '*'::text) OR (rsg.scope = required.scope) OR ("left"(required.scope, (length(rsg.scope) + 1)) = (rsg.scope || ':'::text)) OR (("right"(rsg.scope, 2) = ':*'::text) AND (strpos("left"(rsg.scope, (length(rsg.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(rsg.scope) - 1)) = "left"(rsg.scope, (length(rsg.scope) - 1))))))))))) OR (((( SELECT rls_ctx.user_id() AS user_id))::uuid = ANY (notify_user_ids)) AND (NOT kernel.app_access_denied(org_id, (( SELECT rls_ctx.user_id() AS user_id))::uuid, split_part(tool_name, ':'::text, 1))) AND (EXISTS ( SELECT 1
   FROM ( SELECT COALESCE(approval_requests.approve_scope, (split_part(approval_requests.tool_name, ':'::text, 1) || ':approve'::text)) AS scope) required
  WHERE ((EXISTS ( SELECT 1
           FROM kernel.user_scope_grants g
          WHERE ((g.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (g.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((g.scope = '*'::text) OR (g.scope = required.scope) OR ("left"(required.scope, (length(g.scope) + 1)) = (g.scope || ':'::text)) OR (("right"(g.scope, 2) = ':*'::text) AND (strpos("left"(g.scope, (length(g.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(g.scope) - 1)) = "left"(g.scope, (length(g.scope) - 1)))))))) OR (EXISTS ( SELECT 1
           FROM (kernel.user_roles ur
             JOIN kernel.role_scope_grants rsg ON ((rsg.role_id = ur.role_id)))
          WHERE ((ur.user_id = (( SELECT rls_ctx.user_id() AS user_id))::uuid) AND (ur.org_id = (( SELECT rls_ctx.org_id() AS org_id))::uuid) AND ((rsg.scope = '*'::text) OR (rsg.scope = required.scope) OR ("left"(required.scope, (length(rsg.scope) + 1)) = (rsg.scope || ':'::text)) OR (("right"(rsg.scope, 2) = ':*'::text) AND (strpos("left"(rsg.scope, (length(rsg.scope) - 1)), '*'::text) = 0) AND ("left"(required.scope, (length(rsg.scope) - 1)) = "left"(rsg.scope, (length(rsg.scope) - 1)))))))))))) OR ((tool_name ~~ 'tickets:%'::text) AND app_tickets.app_has_scope('tickets:tickets:read'::text) AND (NOT (EXISTS ( SELECT 1
   FROM jsonb_array_elements_text(
        CASE
            WHEN (jsonb_typeof((approval_requests.metadata -> 'taintAudienceMustHold'::text)) = 'array'::text) THEN (approval_requests.metadata -> 'taintAudienceMustHold'::text)
            ELSE '[]'::jsonb
        END) must(scope)
  WHERE (NOT app_tickets.app_has_scope(must.scope)))))) OR ((tool_name ~~ 'mail:%'::text) AND app_tickets.app_has_scope('mail:conversations:read'::text) AND (NOT (EXISTS ( SELECT 1
   FROM jsonb_array_elements_text(
        CASE
            WHEN (jsonb_typeof((approval_requests.metadata -> 'taintAudienceMustHold'::text)) = 'array'::text) THEN (approval_requests.metadata -> 'taintAudienceMustHold'::text)
            ELSE '[]'::jsonb
        END) must(scope)
  WHERE (NOT app_tickets.app_has_scope(must.scope))))))))))
  );
