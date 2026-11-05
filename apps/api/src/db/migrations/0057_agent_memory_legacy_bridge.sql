-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_memory RLS: a TRANSITIONAL legacy bridge for NULL owner_agent_id
-- rows (P1a critical fix), plus tightening role/system memory writes to
-- require admin (P1a-T10 write-branch amendment).
--
-- TRANSITIONAL LEGACY BRIDGE (do not remove without reading this):
-- A personal agent is only ever created at registration time
-- (bootstrapRegister / inviteRegister). Every user who existed BEFORE this
-- feature shipped has NO personal agent, so 0055's backfill
-- (`UPDATE kernel.agent_memory SET owner_agent_id = a.id FROM kernel.agents a
-- WHERE a.owner_user_id = m.user_id AND a.kind = 'personal' ...`) matches
-- nothing for them and their memory rows keep owner_agent_id IS NULL. 0056's
-- four policies all gate through `EXISTS (... a.id = agent_memory.owner_agent_id
-- ...)`, which can never match NULL — so every pre-existing user's memory
-- rows became permanently unreadable AND unwritable by anyone, including
-- their rightful owner, the moment 0056 landed. The blueprint defers the 1:1
-- personal-agent creation and data copy for existing users to slice 1b, so
-- this NULL-owner state is a real, expected intermediate state that 0056
-- failed to account for.
--
-- The fix below adds one clause to each policy:
--   (owner_agent_id IS NULL AND user_id = <current user id>)
-- This is EXACTLY the old pre-0056 predicate (0000_initial.sql's
-- agent_user_memory_select/insert/update/delete, carried across the 0055
-- RENAME TO). It restores the previous behaviour for legacy rows ONLY and
-- cannot widen visibility beyond what those rows already had before 0056 —
-- it is a bridge back to the prior state, never a loosening past it.
--
-- REMOVAL: slice 1b must DROP this clause (and this migration's comment)
-- once every user has a personal agent and the 1:1 memory copy has run, i.e.
-- once `SELECT 1 FROM kernel.agent_memory WHERE owner_agent_id IS NULL` finds
-- no rows. At that point every row is owned by an agent and the clause is
-- dead weight that only widens the attack surface for review.
--
-- WRITE-BRANCH AMENDMENT (deliberate, spec-driven, beyond the blueprint's
-- literal T10 wording): 0056's INSERT/UPDATE/DELETE policies let ANY org
-- member write ANY role or system agent's memory row (org match plus
-- `kind IN ('role', 'system')`, no scope gate at all). Memory is injected
-- into that agent's turns, so an unscoped write is a prompt-injection
-- surface. Decision A15 requires kernel:agents:admin (or the wildcard '*')
-- for a write to a role or system agent's assets; the blueprint reasoned
-- only about the SELECT branch (which already gates role/system reads on
-- scopes_cover_ceiling against required_scopes), so this tightens the write
-- branch to match, following the exact idiom 0048_routines_owner_agent.sql
-- uses for the same role/system-vs-personal split on kernel.routines. This
-- is safe: a role or system agent's own turn writes its memory over the
-- privileged connection (withPrivilegedDb / withSystemDb), which BYPASSES
-- RLS entirely, and no production caller writes role/system agent memory
-- through liaison_rls in this slice (verified: apps/api/src/services/agent/
-- memory.ts is the only write surface for kernel.agent_memory through
-- liaison_rls, and every insert/update/delete there resolves
-- owner_agent_id to the CALLING user's OWN personal agent — there is no
-- role/system write path through this RLS connection today).
--
-- NULLIF form: casting an EMPTY GUC string to uuid throws (a live landmine
-- in this codebase), so every current-user comparison uses
-- `nullif(current_setting('app.current_user_id', true), '')::uuid`, matching
-- 0056/0053's idiom, never a bare `current_setting(...)::uuid`.
--
-- Re-runnable: DROP POLICY IF EXISTS before each CREATE, following the
-- convention 0033/0045/0047/0048/0056 established.

DROP POLICY IF EXISTS agent_memory_select ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_memory_insert ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_memory_update ON kernel.agent_memory;
DROP POLICY IF EXISTS agent_memory_delete ON kernel.agent_memory;
--> statement-breakpoint

CREATE POLICY agent_memory_select ON kernel.agent_memory FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- TRANSITIONAL legacy bridge, see migration header: restores the
      -- pre-0056 predicate for rows slice 1b has not backfilled yet.
      (
        kernel.agent_memory.owner_agent_id IS NULL
        AND kernel.agent_memory.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
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
    AND (
      -- TRANSITIONAL legacy bridge, see migration header.
      (
        kernel.agent_memory.owner_agent_id IS NULL
        AND kernel.agent_memory.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
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
  );
--> statement-breakpoint

CREATE POLICY agent_memory_update ON kernel.agent_memory FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- TRANSITIONAL legacy bridge, see migration header.
      (
        kernel.agent_memory.owner_agent_id IS NULL
        AND kernel.agent_memory.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
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
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- TRANSITIONAL legacy bridge, see migration header.
      (
        kernel.agent_memory.owner_agent_id IS NULL
        AND kernel.agent_memory.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
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
  );
--> statement-breakpoint

CREATE POLICY agent_memory_delete ON kernel.agent_memory FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- TRANSITIONAL legacy bridge, see migration header.
      (
        kernel.agent_memory.owner_agent_id IS NULL
        AND kernel.agent_memory.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_memory.owner_agent_id
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
  );
