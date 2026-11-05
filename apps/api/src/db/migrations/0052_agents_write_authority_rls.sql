-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agents: the write-authority RLS T02 (0045) deferred - who may
-- INSERT or UPDATE an agent row, split by `kind`.
--
-- INSERT: org match AND caller holds kernel:agents:admin, unconditionally.
-- Role and system agents are admin-created only; a personal agent's insert
-- happens through withSystemDb/privileged paths (T17/T18) that bypass
-- liaison_rls entirely, so the ordinary liaison_rls INSERT policy can
-- require admin without a personal-kind carve-out - a human never directly
-- INSERTs their own personal agent row through the RLS-governed path.
--
-- UPDATE: org match AND
--   kind IN ('role','system')  -> kernel:agents:admin
--   kind = 'personal'          -> kernel:agents:admin (archive/offboard,
--                                 checked in WITH CHECK only so an admin can
--                                 always write), OR the owner (checked in
--                                 both USING and WITH CHECK) - but the WITH
--                                 CHECK owner branch additionally requires
--                                 archived_at IS NULL in the new row, so an
--                                 owner without admin can rename but cannot
--                                 archive their own agent. Renaming the
--                                 `handle` itself is blocked for every actor
--                                 by 0051's agents_handle_immutable trigger,
--                                 independent of this policy.
--
-- No agents_delete policy: agents are archived via archived_at, never row-
-- deleted, per D16's "vanish from pickers... history is not deleted".
--
-- RE-RUNNABLE: CREATE POLICY is dropped by name first, following the
-- convention 0033/0045/0047 established for a journal `when` raised above
-- an already-deployed highwater re-running this file.

DROP POLICY IF EXISTS agents_insert ON kernel.agents;
DROP POLICY IF EXISTS agents_update ON kernel.agents;
--> statement-breakpoint

CREATE POLICY agents_insert ON kernel.agents FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

CREATE POLICY agents_update ON kernel.agents FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (
        kind IN ('role', 'system')
        AND (
          '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
          OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        )
      )
      OR (
        kind = 'personal'
        AND (
          owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
          OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        )
      )
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (
        kind IN ('role', 'system')
        AND (
          '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
          OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        )
      )
      OR (
        kind = 'personal'
        AND (
          '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
          OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
          OR (
            owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND archived_at IS NULL
          )
        )
      )
    )
  );
