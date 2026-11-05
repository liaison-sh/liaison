-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Trusted senders: an address, or a whole domain, that staff marked as trusted
-- for their org. Mail from a trusted sender that arrives without a provider
-- verdict counts as verified for the inbound rules (acknowledgement, desk
-- routing, adding participants), and a trusted address or domain counts as a
-- known calendar guest. A public mail provider's domain is refused by the
-- routes (single addresses there only).
--
-- Members of the org read the list; it is written only through the contacts
-- routes, which check the contacts or tickets admin scope, run privileged and
-- record each change as an audited event. Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.trusted_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('address', 'domain')),
  value text NOT NULL CHECK (value = lower(value) AND value <> ''),
  created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS trusted_senders_org_kind_value_idx
  ON kernel.trusted_senders (org_id, kind, value);
--> statement-breakpoint
ALTER TABLE kernel.trusted_senders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.trusted_senders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON kernel.trusted_senders TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS trusted_senders_select ON kernel.trusted_senders;
--> statement-breakpoint
CREATE POLICY trusted_senders_select ON kernel.trusted_senders FOR SELECT TO liaison_rls
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
