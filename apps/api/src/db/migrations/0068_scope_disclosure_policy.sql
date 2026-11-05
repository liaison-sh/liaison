-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.scope_disclosure_policy (P2b-T06, spec-security.md D4 and S7): the
-- per-org, per-scope switch an admin uses to make a capability
-- non-disclosable, so "Share anyway" stops being offered for it.
--
-- DEFAULT DISCLOSABLE: no row means disclosable, and a row inserted without an
-- explicit value gets `disclosable = true`. Only a deliberate write restricts.
--
-- TIGHTEN-ONLY (S7): the rule "once false, never true again" compares the old
-- row to the new one, which a CHECK constraint cannot see, so P2b-T09 enforces
-- it in code on the update path. This migration closes the loophole under that
-- guard instead: liaison_rls gets NO DELETE policy, so a tightened row cannot
-- be deleted and re-inserted to fall back to the disclosable default. A
-- BEFORE UPDATE trigger is deliberately NOT added here: P2b-T09 owns the
-- enforcement and its typed error, and a second, differently-shaped authority
-- in the database would make that guard's failure mode ambiguous.
--
-- RLS: SELECT for any member of the org (the Share-anyway check reads this at
-- turn time for every requester, not only admins). INSERT and UPDATE require
-- `kernel:agents:admin`, the admin scope 0052 established for agent-adjacent
-- policy tables, checked exactly the way agents_insert checks it (a literal
-- `*` grant, or the scope itself, in app.current_scopes).
--
-- Safe against existing data: the table is new, so there is nothing to
-- backfill, and every statement is guarded (IF NOT EXISTS, DROP POLICY IF
-- EXISTS before CREATE POLICY) so a re-run is a no-op, following the
-- convention 0033/0045/0047/0049 established for a journal `when` raised above
-- an already-deployed highwater.

CREATE TABLE IF NOT EXISTS kernel.scope_disclosure_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  disclosable boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scope_disclosure_policy_org_scope_idx
  ON kernel.scope_disclosure_policy (org_id, scope);
--> statement-breakpoint
ALTER TABLE kernel.scope_disclosure_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.scope_disclosure_policy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.scope_disclosure_policy TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS scope_disclosure_policy_select ON kernel.scope_disclosure_policy;
--> statement-breakpoint
CREATE POLICY scope_disclosure_policy_select ON kernel.scope_disclosure_policy
  FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS scope_disclosure_policy_insert ON kernel.scope_disclosure_policy;
--> statement-breakpoint
CREATE POLICY scope_disclosure_policy_insert ON kernel.scope_disclosure_policy
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS scope_disclosure_policy_update ON kernel.scope_disclosure_policy;
--> statement-breakpoint
CREATE POLICY scope_disclosure_policy_update ON kernel.scope_disclosure_policy
  FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
