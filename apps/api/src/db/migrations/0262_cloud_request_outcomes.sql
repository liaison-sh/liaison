-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Outcomes of the signed Control→cell requests (`/api/cloud/*`, managed edition
-- only, `modules/cloud/`): one row per endpoint and idempotency key, so a repeat
-- of a request returns the first outcome instead of acting twice.
--
-- A row is claimed before the work (`outcome_sealed` null) and completed with
-- the reply, sealed with the instance encryption key (a handoff reply carries a
-- one-time sign-in link). `binding_hash` is the sha256 of the request fields a
-- repeat must match (the owner email for an org, the org for a handoff).
-- `expires_at` set = deleted once past (handoff outcomes live 600 s).
--
-- Additive: a new table nobody reads before this release. The privileged pool
-- alone reads and writes it (RLS forced, no policy, no request-role grant).
CREATE TABLE IF NOT EXISTS kernel.cloud_request_outcomes (
  endpoint text NOT NULL,
  idem_key text NOT NULL,
  binding_hash text NOT NULL,
  status_code integer NULL,
  outcome_sealed text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  expires_at timestamptz NULL,
  PRIMARY KEY (endpoint, idem_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cloud_request_outcomes_expires
  ON kernel.cloud_request_outcomes (expires_at)
  WHERE expires_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.cloud_request_outcomes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.cloud_request_outcomes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.cloud_request_outcomes FROM liaison_rls;
