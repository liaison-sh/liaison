-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Deployment-wide decisions that must be taken ONCE and then hold on every
-- process, for the life of the deployment. The first one is how personal
-- mailboxes are encrypted by default when MAILBOX_ENCRYPTION_DEFAULT is unset
-- (`mail.encryption_default`): decided on first use (private when anyone had
-- set up a private mailbox by then, else transparent) and never re-decided, so
-- a later preference or enrollment can never flip a zero-access deployment to
-- server-managed, and two processes can never disagree.
--
-- Additive: a new table nobody reads before this release. The privileged pool
-- alone reads and writes it (RLS forced, no policy).
CREATE TABLE IF NOT EXISTS kernel.instance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE kernel.instance_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.instance_settings FORCE ROW LEVEL SECURITY;
