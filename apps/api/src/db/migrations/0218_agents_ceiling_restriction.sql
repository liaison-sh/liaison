-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A personal agent's ceiling follows its owner's grants: every grant change
-- re-derives it (personal-agent.ts). An administrator may also narrow one
-- person's agent on purpose; that narrowing is kept here, apart from the
-- derived ceiling, so a recompute keeps it: ceiling = owner's current scopes
-- ∩ ceiling_restriction, or the owner's scopes when it is NULL. Never wider
-- than the owner, never wider than the restriction.
--
-- Existing rows start unrestricted (NULL): a stored ceiling cannot tell a
-- deliberate narrowing from a stale snapshot, and keeping a stale snapshot is
-- the defect this column exists to end.
--
-- The owner of a personal agent may not change its restriction, exactly as
-- they may not change its ceiling (0210's trigger, extended below).
--
-- Every statement is re-runnable.
ALTER TABLE kernel.agents ADD COLUMN IF NOT EXISTS ceiling_restriction jsonb;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.agents_personal_owner_rename_only() RETURNS trigger AS $FUNCTION_BODY$
DECLARE
  acting_scopes text[];
BEGIN
  IF NEW.kind != 'personal' THEN
    RETURN NEW;
  END IF;

  IF pg_catalog.pg_has_role(current_user, 'liaison_admin', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  acting_scopes := COALESCE(string_to_array(rls_ctx.scopes(), ','), ARRAY[]::text[]);
  IF '*' = ANY(acting_scopes) OR 'kernel:agents:admin' = ANY(acting_scopes) THEN
    RETURN NEW;
  END IF;

  IF NEW.scope_ceiling IS DISTINCT FROM OLD.scope_ceiling
    OR NEW.ceiling_restriction IS DISTINCT FROM OLD.ceiling_restriction
    OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
    OR NEW.tool_allowlist IS DISTINCT FROM OLD.tool_allowlist
    OR NEW.tool_denylist IS DISTINCT FROM OLD.tool_denylist
  THEN
    RAISE EXCEPTION 'agents_personal_owner_rename_only';
  END IF;

  RETURN NEW;
END;
$FUNCTION_BODY$ LANGUAGE plpgsql;
