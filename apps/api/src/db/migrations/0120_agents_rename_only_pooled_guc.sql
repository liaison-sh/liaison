-- SPDX-License-Identifier: FSL-1.1-ALv2
-- 0053's trigger treats an unset `app.current_scopes` (SQL NULL) as a
-- privileged connection. That only holds on a fresh server session: once any
-- transaction on a server connection has called set_config on the GUC (every
-- withRlsContext does), Postgres keeps the placeholder defined and later
-- transactions on that connection read `''`, not NULL. PgBouncer in
-- transaction mode hands the same server connections to the RLS and the
-- privileged pools, so a liaison_admin write (recomputePersonalAgentCeiling,
-- run by every role or scope grant) was refused with
-- `agents_personal_owner_rename_only` and the grant approval failed.
--
-- `''` is now treated like NULL. An RLS connection never sets `''`: it sets a
-- comma-joined scope list or the literal `'__none__'`, so a real RLS actor
-- with no scopes is still not treated as admin.
--
-- RE-RUNNABLE: CREATE OR REPLACE FUNCTION; the trigger itself is unchanged.

CREATE OR REPLACE FUNCTION kernel.agents_personal_owner_rename_only() RETURNS TRIGGER AS $TRIGGER_BODY$
DECLARE
  acting_scopes text;
  is_admin boolean;
BEGIN
  IF NEW.kind != 'personal' THEN
    RETURN NEW;
  END IF;

  acting_scopes := current_setting('app.current_scopes', true);
  -- NULL (GUC never set in this session) or '' (set by an earlier transaction
  -- on this pooled server connection, then reverted) = a privileged connection.
  is_admin := acting_scopes IS NULL
    OR acting_scopes = ''
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
