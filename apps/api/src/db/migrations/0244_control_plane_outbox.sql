-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The Liaison team outbox: every message this instance sends to the Liaison
-- team's control plane (registration, heartbeat, forwarded bug reports and
-- their attachments, demo leads, deregistration) waits here until it is
-- delivered, permanently refused, cancelled or expired, so nothing is lost
-- while the control plane is down (`modules/liaison-team/outbox.ts`).
--
-- A drain claims due rows with a lease (`status = 'sending'`, `lease_until`)
-- in a short transaction and sends outside it; a drain that dies leaves its
-- rows reclaimable once the lease runs out. `depends_on` holds an attachment
-- back until its report is delivered. Delivered, refused, cancelled and expired
-- rows lose their `data` after 7 days (`purged_at`) and are deleted after 90.
--
-- Additive: a new table nobody reads before this release. The privileged pool
-- alone reads and writes it (RLS forced, no policy, no request-role grant).
CREATE TABLE IF NOT EXISTS kernel.control_plane_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  message_id uuid NOT NULL UNIQUE,
  depends_on uuid NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'delivered', 'refused', 'cancelled', 'expired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NULL,
  last_status integer NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL,
  purged_at timestamptz NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_control_plane_outbox_due
  ON kernel.control_plane_outbox (next_attempt_at)
  WHERE status IN ('pending', 'sending');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_control_plane_outbox_depends_on
  ON kernel.control_plane_outbox (depends_on)
  WHERE depends_on IS NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.control_plane_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.control_plane_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.control_plane_outbox FROM liaison_rls;
