-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agents: 0052's `agents_update` owner branch for a `kind='personal'`
-- row checks ONLY `archived_at IS NULL` in its WITH CHECK, so an owner
-- holding no agent scope at all could still UPDATE every other column of
-- their own personal agent row, including `scope_ceiling`, `system_prompt`,
-- `tool_allowlist` and `tool_denylist`.
--
-- spec-agents.md: a personal agent's ceiling is "computed = owner's current
-- grants ... never independently widened", and owner-side update authority
-- is "rename only" (i.e. `display_name`). `WITH CHECK` cannot see the row's
-- OLD values, so the immutability 0051 used for `handle` (a BEFORE UPDATE
-- trigger) is the right shape here too: for a `kind='personal'` row updated
-- by an actor who is neither `'*'` nor `kernel:agents:admin`, pin
-- `scope_ceiling`, `system_prompt`, `tool_allowlist` and `tool_denylist` to
-- their OLD values.
--
-- BYPASSRLS connections (liaison_admin — withPrivilegedDb/withSystemDb, used
-- by `recomputePersonalAgentCeiling` and `archiveAgent`) skip row security
-- but NOT triggers, and NEVER set `app.current_scopes` (only
-- `app.current_org_id`) — `current_setting(..., true)` on an unset GUC
-- returns SQL NULL, which this trigger treats as admin. An `liaison_rls`
-- connection, by contrast, ALWAYS sets this GUC explicitly (`withRlsContext`
-- / rls.ts), to either a real comma-joined scope list or the literal string
-- `'__none__'` for an actor with zero scopes — never to NULL and never to
-- `''` — so a real RLS actor with no scopes at all is correctly NOT treated
-- as admin here.
--
-- RE-RUNNABLE: CREATE OR REPLACE FUNCTION is naturally idempotent, and the
-- trigger is dropped by name first, following the convention 0033/0045/0051
-- established for a journal `when` raised above an already-deployed
-- highwater re-running this file.

CREATE OR REPLACE FUNCTION kernel.agents_personal_owner_rename_only() RETURNS TRIGGER AS $TRIGGER_BODY$
DECLARE
  acting_scopes text;
  is_admin boolean;
BEGIN
  IF NEW.kind != 'personal' THEN
    RETURN NEW;
  END IF;

  acting_scopes := current_setting('app.current_scopes', true);
  -- NULL = GUC never set at all (a BYPASSRLS/privileged connection) -> admin.
  -- A real RLS connection always sets this GUC (to a scope list or the
  -- literal '__none__'), so it is never NULL and never '' here.
  is_admin := acting_scopes IS NULL
    OR '*' = ANY(string_to_array(acting_scopes, ','))
    OR 'kernel:agents:admin' = ANY(string_to_array(acting_scopes, ','));

  IF is_admin THEN
    RETURN NEW;
  END IF;

  IF NEW.scope_ceiling IS DISTINCT FROM OLD.scope_ceiling
    OR NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
    OR NEW.tool_allowlist IS DISTINCT FROM OLD.tool_allowlist
    OR NEW.tool_denylist IS DISTINCT FROM OLD.tool_denylist
  THEN
    RAISE EXCEPTION 'agents_personal_owner_rename_only';
  END IF;

  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS agents_personal_owner_rename_only ON kernel.agents;
CREATE TRIGGER agents_personal_owner_rename_only
  BEFORE UPDATE OF scope_ceiling, system_prompt, tool_allowlist, tool_denylist ON kernel.agents
  FOR EACH ROW EXECUTE FUNCTION kernel.agents_personal_owner_rename_only();
