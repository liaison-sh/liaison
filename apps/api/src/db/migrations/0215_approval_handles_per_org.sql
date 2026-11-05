-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Approval handles (`request-N`) are numbered per organisation.
--
-- They came from one instance-wide sequence (kernel.approval_request_handle_seq),
-- so the gaps in one organisation's numbers counted the approvals every other
-- organisation opened in between. Each organisation now has its own counter.
-- The handles were already unique per organisation only
-- (approval_requests_org_handle_idx), so no existing handle changes: each
-- counter starts after its organisation's highest `request-N`, and an
-- organisation with none starts at 1. A handle the old sequence still hands out
-- while a deploy rolls over can meet the counter later: the counter skips a
-- number the organisation already holds (nextApprovalHandle, lib/handle.ts).
--
-- The counter row is read and bumped only in the organisation's own context.
-- The old sequence stays (it is part of the frozen baseline) and is unused.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS kernel.approval_handle_counters (
  org_id uuid PRIMARY KEY REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  last_value bigint NOT NULL CHECK (last_value >= 0)
);
--> statement-breakpoint
ALTER TABLE kernel.approval_handle_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.approval_handle_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON kernel.approval_handle_counters TO liaison_rls, liaison_app;
--> statement-breakpoint
DROP POLICY IF EXISTS approval_handle_counters_org ON kernel.approval_handle_counters;
--> statement-breakpoint
CREATE POLICY approval_handle_counters_org ON kernel.approval_handle_counters FOR ALL TO liaison_rls
  USING (org_id = rls_ctx.org_id()::uuid)
  WITH CHECK (org_id = rls_ctx.org_id()::uuid);
--> statement-breakpoint
INSERT INTO kernel.approval_handle_counters (org_id, last_value)
SELECT org_id, max(substring(handle FROM '^request-([0-9]{1,18})$')::bigint)
FROM kernel.approval_requests
WHERE handle ~ '^request-[0-9]{1,18}$'
GROUP BY org_id
ON CONFLICT (org_id) DO UPDATE
  SET last_value = GREATEST(kernel.approval_handle_counters.last_value, EXCLUDED.last_value);
