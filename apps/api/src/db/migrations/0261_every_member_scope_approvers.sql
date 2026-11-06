-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Approver eligibility counts the scopes every member holds (2026-11-05).
--
-- A real scope check (`loadEffectivePermissions`, modules/permissions/permissions.ts) adds the
-- kernel's own every-member scopes and the `every_member_scopes` of the org's installed apps to a
-- member's stored grants. Three readers go to the grant tables directly and did not:
-- `eligibleApprovers`, the requester-decides check of the approvals attention provider, and the
-- notified-approver branch of `approval_requests_select`. A person who holds a scope only this way
-- could pass the decide check yet was never an eligible approver, and could not read the row.
--
-- `kernel.every_member_scope_covers(org, user, required)` is the SQL twin of
-- `everyMemberScopeGrants`: an ACTIVE member of the org; the kernel's list (keep it equal to
-- KERNEL_EVERY_MEMBER_SCOPES, every-member-scopes.ts) plus the apps not removed from the workspace;
-- a grant of an app restricted against the person does not count, as `dropAppScopes` takes it from
-- the real check; matched with `hasScope`'s four-branch predicate. Nothing outside those holds true,
-- so no one becomes an approver whom a real scope check would refuse. Pinned against
-- `loadEffectivePermissions` + `hasScope` by eligible-approvers.test.ts, and against the policy by
-- authority-rls-parity.test.ts.
--
-- SECURITY INVOKER and STABLE, like `kernel.app_access_denied`. Everything else in the policy is
-- as it stands after 0193. Re-runnable.
-- A busy table fails the migration fast instead of queueing every reader behind it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- status::text: 0190 adds 'removed' to the enum, and a batch that applies both in one transaction
-- may not use the new value yet (55P04).
CREATE OR REPLACE FUNCTION kernel.every_member_scope_covers(p_org uuid, p_user uuid, p_required text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM kernel.users u
      LEFT JOIN kernel.apps a ON a.org_id = u.org_id AND a.status::text <> 'removed'
      CROSS JOIN LATERAL unnest(
        ARRAY['kernel:bug_reports:file']::text[] || COALESCE(a.every_member_scopes, '{}'::text[])
      ) AS m(scope)
     WHERE u.id = p_user
       AND u.org_id = p_org
       AND u.status = 'active'
       AND NOT kernel.app_access_denied(p_org, p_user, split_part(m.scope, ':', 1))
       AND (
         m.scope = '*'
         OR m.scope = p_required
         OR left(p_required, length(m.scope) + 1) = m.scope || ':'
         OR (
           right(m.scope, 2) = ':*'
           AND strpos(left(m.scope, length(m.scope) - 1), '*') = 0
           AND left(p_required, length(m.scope) - 1) = left(m.scope, length(m.scope) - 1)
         )
       )
  )
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a GRANT EXECUTE on the function this file creates, no dynamic SQL.
GRANT EXECUTE ON FUNCTION kernel.every_member_scope_covers(uuid, uuid, text) TO PUBLIC;
--> statement-breakpoint
-- expand-safe: replaced by a policy that only adds readers, in the same transaction; the previous release reads the same rows and more.
DROP POLICY IF EXISTS approval_requests_select ON kernel.approval_requests;
--> statement-breakpoint
-- expand-safe: only widens the notified-approver branch to the scopes a real check already gives the person; the previous release decides those rows the same way.
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
  WHERE (kernel.every_member_scope_covers(approval_requests.org_id, (( SELECT rls_ctx.user_id() AS user_id))::uuid, required.scope) OR (EXISTS ( SELECT 1
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
