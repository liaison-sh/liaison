-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Policies written after 0184/0185 read the request's org and user through
-- the rls_ctx readers too.
--
-- 0198, 0203, 0206 and 0207 wrote policies that read the session variables
-- `app.current_org_id` / `app.current_user_id` themselves, which any SQL in a
-- request transaction can set. Each is recreated with the same predicate, the
-- variable read replaced the way 0184/0185 replaced it: `rls_ctx.org_id()` /
-- `rls_ctx.user_id()` directly in a policy without a sub-select, and
-- `(SELECT rls_ctx.org_id())` in a policy that already holds one (the
-- mcp_connection_access pair), so no policy gains a sublink it did not have.
-- migrations/rls-ctx-reader.guard.test.ts keeps a later migration from
-- writing the raw read again. Re-runnable.

-- 0203: an import upload is its uploader's.
DROP POLICY IF EXISTS import_uploads_owner_select ON kernel.import_uploads;
--> statement-breakpoint
CREATE POLICY import_uploads_owner_select ON kernel.import_uploads FOR SELECT TO liaison_rls
  USING (
    org_id = rls_ctx.org_id()::uuid
    AND created_by = rls_ctx.user_id()::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS import_uploads_owner_insert ON kernel.import_uploads;
--> statement-breakpoint
CREATE POLICY import_uploads_owner_insert ON kernel.import_uploads FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = rls_ctx.org_id()::uuid
    AND created_by = rls_ctx.user_id()::uuid
  );
--> statement-breakpoint
-- 0206: a secret request is read by its requester and the thread's participants.
DROP POLICY IF EXISTS secret_requests_select ON kernel.secret_requests;
--> statement-breakpoint
CREATE POLICY secret_requests_select ON kernel.secret_requests FOR SELECT TO liaison_rls
  USING (
    org_id = rls_ctx.org_id()::uuid
    AND (
      requested_by = rls_ctx.user_id()::uuid
      OR kernel.is_thread_participant(thread_id, rls_ctx.user_id()::uuid)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS secret_requests_insert ON kernel.secret_requests;
--> statement-breakpoint
CREATE POLICY secret_requests_insert ON kernel.secret_requests FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = rls_ctx.org_id()::uuid
    AND requested_by = rls_ctx.user_id()::uuid
    AND status = 'pending'
    AND kernel.is_thread_participant(thread_id, rls_ctx.user_id()::uuid)
  );
--> statement-breakpoint
-- 0207: import runs are read with kernel:imports:read.
DROP POLICY IF EXISTS import_runs_select ON kernel.import_runs;
--> statement-breakpoint
CREATE POLICY import_runs_select ON kernel.import_runs FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND kernel.has_scope('kernel:imports:read')
  );
--> statement-breakpoint
-- 0198: who may use an org MCP server; read with connection:read, written by
-- the MCP manager admin, the parent always an org connection of the org.
DROP POLICY IF EXISTS mcp_connection_access_select ON app_mcp_manager.mcp_connection_access;
--> statement-breakpoint
CREATE POLICY mcp_connection_access_select ON app_mcp_manager.mcp_connection_access
  FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:read')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = (SELECT rls_ctx.org_id())::uuid
        AND c.ownership_scope = 'org'
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS mcp_connection_access_modify ON app_mcp_manager.mcp_connection_access;
--> statement-breakpoint
CREATE POLICY mcp_connection_access_modify ON app_mcp_manager.mcp_connection_access
  FOR ALL TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:admin')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = (SELECT rls_ctx.org_id())::uuid
        AND c.ownership_scope = 'org'
    )
  )
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:admin')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_access.connection_id
        AND c.org_id = (SELECT rls_ctx.org_id())::uuid
        AND c.ownership_scope = 'org'
    )
  );
