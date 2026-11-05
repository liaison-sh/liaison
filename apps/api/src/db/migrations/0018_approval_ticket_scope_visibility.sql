-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Ticket-scoped visibility for gated tickets:* approvals.
--
-- Bug: TicketApprovalCards (apps/web) needs to show the pending approval for
-- a gated tickets:reply/nudge/close raised by an agent ROUTINE. A routine's
-- gated call hosts the approval_request on the routine's own output thread,
-- not the ticket's internalThreadId, and its notify_user_ids / requested_by
-- are the routine's actor, not the operator viewing the ticket — so the
-- EXISTING approval_requests_select policy (0000_initial.sql) hides the row
-- from any operator who isn't that requester/notify target/kernel admin, even
-- though they can read the ticket itself and are exactly who should see and
-- decide its pending reply draft.
--
-- Fix: widen the SELECT policy with one more OR-branch — any tickets:* tool
-- row is visible to a caller holding tickets:tickets:read (the SAME scope
-- app_tickets' own RLS policies already gate ticket reads on, see
-- app_tickets.reply_templates_select / tickets_select in 0000_initial.sql).
-- This mirrors "if you can read the ticket, you can see its pending
-- reply/nudge/close drafts" rather than requiring thread participancy or
-- kernel-admin scope. Reuses app_tickets.app_has_scope (already defined,
-- JWT-scope-based — no DB grant join, cheap) instead of duplicating scope
-- matching logic in the kernel schema.
--
-- Scoped to tool_name LIKE 'tickets:%' only — no change to bundle/thread/
-- decidable-feed visibility for any other app's gated tools.

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
    )
  );
