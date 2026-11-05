-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Conversation-scoped visibility for gated mail:* approvals.
--
-- Mirror of 0018 (tickets): the mail conversation view now renders pending
-- gated mail:reply/forward drafts inline (`/approvals?conversationId=...`),
-- but a routine/agent-raised approval_request's notify_user_ids and
-- requested_by are the agent actor, not the operator viewing the
-- conversation — so the SELECT policy hides the row from exactly the person
-- who should decide it. Widen with one more OR-branch: any mail:* tool row is
-- visible to a caller holding mail:conversations:read (the same scope mail
-- reads are gated on). Reuses app_tickets.app_has_scope, the generic
-- JWT-scope check 0018 already uses from the kernel schema.
--
-- Scoped to tool_name LIKE 'mail:%' only — every other branch is unchanged
-- from 0018.

DROP POLICY IF EXISTS approval_requests_select ON kernel.approval_requests;
CREATE POLICY approval_requests_select ON kernel.approval_requests FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      requested_by = current_setting('app.current_user_id', true)::uuid
      OR EXISTS (
        SELECT 1
        FROM (VALUES ('kernel:approvals:admin'), ('kernel:users:admin')) AS required(scope)
        WHERE EXISTS (
          SELECT 1 FROM kernel.user_scope_grants g
          WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
            AND g.org_id = current_setting('app.current_org_id', true)::uuid
            AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
        )
        OR EXISTS (
          SELECT 1
          FROM kernel.user_roles ur
          JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
          WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
            AND ur.org_id = current_setting('app.current_org_id', true)::uuid
            AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
        )
      )
      OR (
        current_setting('app.current_user_id', true)::uuid = ANY(notify_user_ids)
        AND EXISTS (
          SELECT 1
          FROM (SELECT split_part(tool_name, ':', 1) || ':approve' AS scope) AS required
          WHERE EXISTS (
            SELECT 1 FROM kernel.user_scope_grants g
            WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
              AND g.org_id = current_setting('app.current_org_id', true)::uuid
              AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
          )
          OR EXISTS (
            SELECT 1
            FROM kernel.user_roles ur
            JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
            WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
              AND ur.org_id = current_setting('app.current_org_id', true)::uuid
              AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
          )
        )
      )
      OR (
        tool_name LIKE 'tickets:%'
        AND app_tickets.app_has_scope('tickets:tickets:read')
      )
      OR (
        tool_name LIKE 'mail:%'
        AND app_tickets.app_has_scope('mail:conversations:read')
      )
    )
  );
