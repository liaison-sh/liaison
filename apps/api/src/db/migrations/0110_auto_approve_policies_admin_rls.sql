-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.auto_approve_policies writes become an admin authority.
--
-- An auto-approve policy LOOSENS a gate: while it holds, a gated tool skips the
-- human approver. The kernel tool that writes one (policy_set) now requires
-- kernel:policies:admin, the scope approval_policy_set (the TIGHTENING twin)
-- already required. The RLS written in 0000 still let kernel:policies:write
-- and kernel:approve insert, update and delete these rows, so any path writing
-- them under RLS kept the old, wider rule. The three write policies are
-- recreated to mirror approval_policies' (0000): '*' or kernel:policies:admin.
--
-- The SELECT policy keeps every scope it had and gains the two approval_policies
-- reads with (kernel:policies, kernel:policies:admin). Without that an admin
-- holding only kernel:policies:admin could insert a row but never see it, so
-- its UPDATE and DELETE (which only reach visible rows) matched nothing.
--
-- Every statement is re-runnable (DROP POLICY IF EXISTS, then CREATE).

DROP POLICY IF EXISTS auto_approve_policies_select ON kernel.auto_approve_policies;
--> statement-breakpoint
CREATE POLICY auto_approve_policies_select ON kernel.auto_approve_policies FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS auto_approve_policies_insert ON kernel.auto_approve_policies;
--> statement-breakpoint
CREATE POLICY auto_approve_policies_insert ON kernel.auto_approve_policies FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS auto_approve_policies_update ON kernel.auto_approve_policies;
--> statement-breakpoint
CREATE POLICY auto_approve_policies_update ON kernel.auto_approve_policies FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS auto_approve_policies_delete ON kernel.auto_approve_policies;
--> statement-breakpoint
CREATE POLICY auto_approve_policies_delete ON kernel.auto_approve_policies FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
