-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Role assignments get the same RLS backstop as direct scope grants.
--
-- 0000 already refuses, at the policy level, a direct grant of a privileged
-- (`*` / `kernel...`) scope to a user or a role from a session that is not a
-- user administrator (user_scope_grants_org_rls, role_scope_grants_org_rls).
-- Assigning a ROLE that carries such a scope reaches the same authority, and
-- user_roles had only the org check. Its write check now matches: a role that
-- grants a privileged scope may be assigned only by an admin session. The
-- application's own check (assignRole: the actor must hold every scope of the
-- role) is unchanged; this is the backstop behind it. Sessions that run as
-- liaison_admin (sign-up, invitation acceptance, provisioning) are unaffected.
--
-- Re-runnable: DROP POLICY IF EXISTS before the CREATE.

DROP POLICY IF EXISTS user_roles_org_rls ON kernel.user_roles;
--> statement-breakpoint
CREATE POLICY user_roles_org_rls ON kernel.user_roles
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      kernel.session_is_admin()
      OR NOT EXISTS (
        SELECT 1 FROM kernel.role_scope_grants g
        WHERE g.role_id = user_roles.role_id AND kernel.scope_is_privileged(g.scope)
      )
    )
  );
