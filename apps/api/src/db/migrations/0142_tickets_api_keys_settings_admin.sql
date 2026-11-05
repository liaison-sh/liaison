-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Tickets API keys reachable by the tickets admin role.
--
-- The apiKeys list/create/revoke tools (and the web settings page) require
-- tickets:settings:admin, but app_tickets.api_keys only had a deny-default
-- policy and the generated api_keys_rls_* ones, which accept no :admin scope.
-- Only a wildcard grant (org owner/admin: '*', 'tickets', 'tickets:*') could
-- reach the table, so a user holding the tickets admin role saw an empty key
-- list, got an RLS error on create and revoked nothing.
--
-- This adds one PERMISSIVE policy for holders of tickets:settings:admin (the
-- reply_templates pattern). It is OR-ed with the existing policies, so every
-- grant that reached the table before still does; a support agent (no
-- settings:admin) still sees and writes no key.
DROP POLICY IF EXISTS api_keys_settings_admin ON app_tickets.api_keys;
--> statement-breakpoint
CREATE POLICY api_keys_settings_admin ON app_tickets.api_keys
  FOR ALL TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_tickets.app_has_scope('tickets:settings:admin')
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_tickets.app_has_scope('tickets:settings:admin')
  );
