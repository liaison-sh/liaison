-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A secret request carries the scopes of the turn that filed it.
--
-- A secret request's target holds text the agent chose (an API key's label and
-- allowed origins, an account identifier), and the row is read by its
-- requester and by whoever is a participant of its conversation NOW: a person
-- added to the conversation after the card was filed reads it too. The agent
-- may have chosen that text after reading scoped data, so the row is stamped
-- with that turn's taint (`required_scopes`, as kernel.messages is), and a
-- reader must hold every one of those scopes to see the row at all. An empty
-- list (every row filed before this, every card no scoped read led to) reads as
-- before. The insert policy is unchanged; status changes run privileged.
-- Re-runnable.
ALTER TABLE kernel.secret_requests
  ADD COLUMN IF NOT EXISTS required_scopes text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
DROP POLICY IF EXISTS secret_requests_select ON kernel.secret_requests;
--> statement-breakpoint
CREATE POLICY secret_requests_select ON kernel.secret_requests FOR SELECT TO liaison_rls
  USING (
    org_id = rls_ctx.org_id()::uuid
    AND (
      requested_by = rls_ctx.user_id()::uuid
      OR kernel.is_thread_participant(thread_id, rls_ctx.user_id()::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(required_scopes) AS req(scope)
       WHERE req.scope <> '' AND NOT kernel.has_scope(req.scope)
    )
  );
