-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_memory RLS rekey to the owning agent (P1a-T10), plus
-- retention-not-deletion for an archived personal agent's memory (P1a-T27).
--
-- Replaces the four user_id-keyed policies Postgres carried across the
-- 0055 RENAME TO (originally agent_user_memory_select/insert/update/delete,
-- 0000_initial.sql:2042-2065) with owner_agent_id-keyed ones, decision A13:
--
-- SELECT: org match AND (
--   the owner agent is kind 'personal' AND agents.owner_user_id matches the
--     caller AND the owner agent is NOT archived (T27: an archived
--     personal agent's memory becomes unreadable through this path, rows
--     are retained, never deleted)
--   OR
--   the owner agent is kind 'role' or 'system' AND the caller holds every
--     one of the row's required_scopes (kernel.scopes_cover_ceiling(),
--     0048_routines_owner_agent.sql — reused rather than hand-rolled: the
--     function's caller_scopes text[] / ceiling jsonb shape fits
--     required_scopes once cast with to_jsonb(), and it already handles the
--     caller holding the wildcard '*' by short-circuiting before the
--     per-element check)
-- )
--
-- INSERT/UPDATE/DELETE mirror the SELECT's OWNERSHIP half only (personal:
-- owner_user_id match; role or system: org match, no required_scopes
-- gate), per the blueprint: at INSERT time the row does not exist yet to
-- check required_scopes against.
--
-- Re-runnable: DROP POLICY IF EXISTS before each CREATE, following the
-- convention 0033/0045/0047/0048 established.

DROP POLICY IF EXISTS agent_user_memory_select ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_user_memory_insert ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_user_memory_update ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_user_memory_delete ON kernel.agent_memory;
--> statement-breakpoint

CREATE POLICY agent_memory_select ON kernel.agent_memory FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
          AND a.kind = 'personal'
          AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND a.archived_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
          AND a.kind IN ('role', 'system')
          AND kernel.scopes_cover_ceiling(
            string_to_array(current_setting('app.current_scopes', true), ','),
            to_jsonb(kernel.agent_memory.required_scopes)
          )
      )
    )
  );
--> statement-breakpoint

CREATE POLICY agent_memory_insert ON kernel.agent_memory FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_memory.owner_agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR a.kind IN ('role', 'system')
        )
    )
  );
--> statement-breakpoint

CREATE POLICY agent_memory_update ON kernel.agent_memory FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_memory.owner_agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR a.kind IN ('role', 'system')
        )
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_memory.owner_agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR a.kind IN ('role', 'system')
        )
    )
  );
--> statement-breakpoint

CREATE POLICY agent_memory_delete ON kernel.agent_memory FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_memory.owner_agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR a.kind IN ('role', 'system')
        )
    )
  );
