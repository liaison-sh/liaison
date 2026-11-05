-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.routines.owner_agent_id: mirrors 0046_skills_owner_agent's shape for
-- routines (P1a-T07). This migration only adds the column, nullable and
-- unenforced; it does not backfill or drop owner_user_id, which stays as
-- provenance (per A15). Routine name uniqueness stays (org_id,
-- owner_user_id, name) — spec-agents.md does not move routine name
-- uniqueness to the agent (only skill name uniqueness moves, per D9), so no
-- index move here.
--
-- Nullable on purpose (sequencing note): a later task backfills every
-- existing routine's owner_agent_id before any NOT NULL is added.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, following the convention 0046
-- established.

ALTER TABLE kernel.routines
  ADD COLUMN IF NOT EXISTS owner_agent_id uuid REFERENCES kernel.agents(id);
--> statement-breakpoint

-- kernel.routines RLS rekey to owner_agent_id (A15) plus the S3 fix (P1a-T08).
--
-- Replaces the four owner-user-keyed policies at 0000_initial.sql:2326-2372
-- (routines_select/insert/update/delete, all `owner_user_id = current_user_id`
-- with zero branch for `visibility`). That zero-branch defect meant a second
-- org member could never read a routine explicitly marked
-- `visibility = 'shared'` (the S3 gap named in grounding-facts.md item 1).
--
-- SELECT: org match AND scope check AND (the caller owns the agent that owns
--   the routine, via a personal-agent lookup keyed off owner_user_id — the
--   rekeyed equivalent of the old owner_user_id check) OR (visibility =
--   'shared' AND the owning agent is confirmed in this org). A row whose
--   owner_agent_id is still NULL (pre-backfill, see 0046's note) matches
--   neither branch and is invisible until a later backfill task populates it
--   (same permissive-during-transition tradeoff 0046/0047 made).
--
-- INSERT/UPDATE/DELETE: scope check AND (owning agent kind IN ('role',
--   'system') AND caller holds kernel:agents:admin, OR kind = 'personal' AND
--   owner_user_id = caller) — same admin-interim shape 0047 used for skills.
--   INSERT/UPDATE additionally require kernel.scopes_cover_ceiling(): the
--   caller's own effective scopes must be a full superset of the owning
--   agent's scope_ceiling (A15: "holding the agent's full ceiling to create
--   or edit a routine it owns"). This superset check is over an arbitrary
--   jsonb text array and cannot be expressed inline in a WITH CHECK clause,
--   hence the helper function below.

CREATE OR REPLACE FUNCTION kernel.scopes_cover_ceiling(caller_scopes text[], ceiling jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    '*' = ANY(caller_scopes)
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(coalesce(ceiling, '[]'::jsonb)) AS c(scope)
      WHERE c.scope <> ALL(caller_scopes)
    )
$$;
--> statement-breakpoint

DROP POLICY IF EXISTS routines_select ON kernel.routines;
DROP POLICY IF EXISTS routines_insert ON kernel.routines;
DROP POLICY IF EXISTS routines_update ON kernel.routines;
DROP POLICY IF EXISTS routines_delete ON kernel.routines;
--> statement-breakpoint

CREATE POLICY routines_select ON kernel.routines FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      kernel.routines.owner_agent_id IN (
        SELECT id FROM kernel.agents
        WHERE owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      )
      OR (
        kernel.routines.visibility = 'shared'
        AND EXISTS (
          SELECT 1 FROM kernel.agents a
          WHERE a.id = kernel.routines.owner_agent_id
            AND a.org_id = current_setting('app.current_org_id', true)::uuid
        )
      )
    )
  );
--> statement-breakpoint

CREATE POLICY routines_insert ON kernel.routines FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.routines.owner_agent_id
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
        AND kernel.scopes_cover_ceiling(
          string_to_array(current_setting('app.current_scopes', true), ','),
          a.scope_ceiling
        )
    )
  );
--> statement-breakpoint

CREATE POLICY routines_update ON kernel.routines FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.routines.owner_agent_id
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
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.routines.owner_agent_id
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
        AND kernel.scopes_cover_ceiling(
          string_to_array(current_setting('app.current_scopes', true), ','),
          a.scope_ceiling
        )
    )
  );
--> statement-breakpoint

CREATE POLICY routines_delete ON kernel.routines FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.routines.owner_agent_id
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
