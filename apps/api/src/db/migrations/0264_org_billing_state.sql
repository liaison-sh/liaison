-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.org_billing_state: the billing state the control plane pushes to a
-- managed cell (`POST /api/cloud/orgs/:id/billing`, modules/cloud/billing.ts).
-- One row per org. `version` is the control plane's monotonic per-org
-- sequence: a push is applied only when it is newer than the stored one, so a
-- late or reordered delivery never overwrites a newer state. The cell serves
-- `GET /api/billing/state` from this row, so a control plane outage never
-- blocks it. Self-hosted servers never write it.
--
-- Org data: FORCE RLS, readable by the row's org. Written only through the
-- privileged connection (the signed control plane API), so liaison_rls gets
-- no write policy.
--
-- Additive, every statement re-runnable.

CREATE TABLE IF NOT EXISTS kernel.org_billing_state (
  org_id uuid PRIMARY KEY REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  plan text NOT NULL,
  status text NOT NULL,
  period_end timestamptz NOT NULL,
  included_credits numeric(20,8) NOT NULL,
  caps jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_ends_at timestamptz NULL,
  auto_top_up jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE kernel.org_billing_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_billing_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.org_billing_state TO liaison_rls;
--> statement-breakpoint
-- Default privileges hand liaison_rls write grants on a new table; it writes
-- nothing here.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON kernel.org_billing_state FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_billing_state TO liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS org_billing_state_select ON kernel.org_billing_state;
--> statement-breakpoint
CREATE POLICY org_billing_state_select ON kernel.org_billing_state FOR SELECT TO liaison_rls
  USING (org_id = NULLIF(rls_ctx.org_id(), '')::uuid);
