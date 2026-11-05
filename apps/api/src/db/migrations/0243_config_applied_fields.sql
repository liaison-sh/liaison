-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.config_applied_fields: the last-applied record of `liaison config
-- apply` (cli/config/drift.ts). One row per org and config path the apply
-- wrote or found already in the desired state: a sha256 of the stored value as
-- read back after the apply (never the value itself), when, and who applied it.
-- The next apply compares the server's current value with this hash to tell a
-- change made elsewhere (the product UI, an agent) since the last apply, and
-- refuses to overwrite it silently. Secret fields are never tracked.
--
-- Org data: FORCE RLS, readable by the row's org for holders of
-- `kernel:org:admin`. Written only through the privileged connection (the
-- CLI), so liaison_rls gets no write policy.
--
-- Additive, every statement re-runnable.

CREATE TABLE IF NOT EXISTS kernel.config_applied_fields (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  path text NOT NULL,
  value_hash text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL,
  PRIMARY KEY (org_id, path)
);
--> statement-breakpoint
ALTER TABLE kernel.config_applied_fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.config_applied_fields FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.config_applied_fields TO liaison_rls;
--> statement-breakpoint
-- Default privileges hand liaison_rls write grants on a new table; it writes
-- nothing here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON kernel.config_applied_fields FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.config_applied_fields TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS config_applied_fields_select ON kernel.config_applied_fields;
--> statement-breakpoint
CREATE POLICY config_applied_fields_select ON kernel.config_applied_fields FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND kernel.has_scope('kernel:org:admin')
  );
