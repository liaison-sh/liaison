-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.skills RLS rekey to owner_agent_id (A15). Replaces the author-keyed
-- select/insert/update/delete policies (0000_initial.sql originally at
-- 2197-2276) with agent-keyed write authority:
--
-- SELECT: org match AND scope check (unchanged scope-hierarchy clause) AND
--   the owning agent is kind 'role'/'system', OR kind 'personal' AND owned
--   by the caller. Expressed as an EXISTS subquery against kernel.agents
--   joined on owner_agent_id (structural precedent: rls-generator.ts's
--   personalScope subquery-based RLS clause, not copied verbatim since
--   this is a hand-written policy).
--
-- INSERT/UPDATE/DELETE: same scope-hierarchy clause AND ((owning agent kind
--   IN ('role','system') AND caller holds kernel:agents:admin) OR (kind =
--   'personal' AND owned by the caller)). Per-agent author grants are not
--   implemented yet in this tree (A15 allows kernel:agents:admin as the
--   interim, not a requirement).
--
-- A row whose owner_agent_id is still NULL (pre-backfill, see 0046) matches
-- neither EXISTS branch and is invisible under every policy below until a
-- later backfill task populates it; this is the same permissive-during-
-- transition tradeoff 0046 made for the unique index.

DROP POLICY IF EXISTS skills_select ON kernel.skills;
DROP POLICY IF EXISTS skills_insert ON kernel.skills;
DROP POLICY IF EXISTS skills_update ON kernel.skills;
DROP POLICY IF EXISTS skills_delete ON kernel.skills;
--> statement-breakpoint

CREATE POLICY skills_select ON kernel.skills FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.skills.owner_agent_id
        AND (
          a.kind IN ('role', 'system')
          OR (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
    )
  );
--> statement-breakpoint

CREATE POLICY skills_insert ON kernel.skills FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.skills.owner_agent_id
        AND (
          (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
          OR (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
    )
  );
--> statement-breakpoint

CREATE POLICY skills_update ON kernel.skills FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.skills.owner_agent_id
        AND (
          (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
          OR (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.skills.owner_agent_id
        AND (
          (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
          OR (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
    )
  );
--> statement-breakpoint

CREATE POLICY skills_delete ON kernel.skills FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.skills.owner_agent_id
        AND (
          (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
          OR (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
        )
    )
  );
