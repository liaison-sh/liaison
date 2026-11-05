-- SPDX-License-Identifier: FSL-1.1-ALv2
-- secret_requests_select reads the request context once per statement.
--
-- 0220 recreated the policy with a sublink (the required_scopes check) and
-- bare rls_ctx calls. In a policy that holds a sublink, Postgres evaluates a
-- bare rls_ctx.org_id() / user_id() per row; wrapped in a sub-select it becomes
-- an InitPlan that runs once (0186, guarded by db/rls-grants-context.test.ts).
-- Same predicate, same readers: only the evaluation changes. Re-runnable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the same predicate, only its rls_ctx calls wrapped in sub-selects; the previous release sees the same rows
ALTER POLICY secret_requests_select ON kernel.secret_requests
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      requested_by = (SELECT rls_ctx.user_id())::uuid
      OR kernel.is_thread_participant(thread_id, (SELECT rls_ctx.user_id())::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(required_scopes) AS req(scope)
       WHERE req.scope <> '' AND NOT kernel.has_scope(req.scope)
    )
  );
