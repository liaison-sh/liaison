-- SPDX-License-Identifier: FSL-1.1-ALv2
-- FX1: kernel.agent_thread_checkpoints policies gain a THREAD MEMBERSHIP
-- predicate.
--
-- 0082's four policies gate a role or system agent's checkpoint on
-- kernel.scopes_cover_ceiling against required_scopes and nothing else. A
-- checkpoint is a summary of ONE conversation, and covering the scopes that
-- conversation happened to touch is not the same thing as being in the room:
-- any org member holding those scopes could SELECT a role agent's checkpoint of
-- a thread they have never been part of, straight out of the table.
--
-- kernel.messages has answered this since 0000_initial (a participant row for
-- the acting human on the message's thread), and 0060 kept that clause when it
-- added the visibility half. A checkpoint of a thread is content of that
-- thread, so it takes the SAME predicate, ANDed onto everything 0082 already
-- required. Nothing is relaxed: a caller now needs the room AND the scopes.
--
-- The service layer joins kernel.threads for the same reason and keeps doing
-- so: the join is how the render inherits thread visibility in one query, and
-- this policy is the backstop underneath it, not a replacement for it.
--
-- Every statement is re-runnable: each policy is dropped IF EXISTS and
-- recreated whole (a policy cannot be amended in place).

DROP POLICY IF EXISTS agent_thread_checkpoints_select ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_select ON kernel.agent_thread_checkpoints FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = kernel.agent_thread_checkpoints.thread_id
        AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND tp.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
    AND (
      EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_thread_checkpoints.agent_id
          AND a.kind = 'personal'
          AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND a.archived_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_thread_checkpoints.agent_id
          AND a.kind IN ('role', 'system')
          AND kernel.scopes_cover_ceiling(
            string_to_array(current_setting('app.current_scopes', true), ','),
            to_jsonb(kernel.agent_thread_checkpoints.required_scopes)
          )
      )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_insert ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_insert ON kernel.agent_thread_checkpoints FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = kernel.agent_thread_checkpoints.thread_id
        AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND tp.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_update ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_update ON kernel.agent_thread_checkpoints FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = kernel.agent_thread_checkpoints.thread_id
        AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND tp.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = kernel.agent_thread_checkpoints.thread_id
        AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND tp.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_delete ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_delete ON kernel.agent_thread_checkpoints FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = kernel.agent_thread_checkpoints.thread_id
        AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND tp.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
