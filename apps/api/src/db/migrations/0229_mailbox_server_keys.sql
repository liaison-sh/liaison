-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Server-managed mailbox encryption: one data key per personal mailbox.
--
-- A mailbox in the `managed` encryption state is sealed under a per-mailbox
-- data key (DEK) that the server can unwrap, so the owner and the owner's agent
-- read it without a browser. The DEK is stored wrapped with AES-256-GCM under
-- ENCRYPTION_KEY (`kek_ref = 'env'`), bound by AAD to its org, account and
-- version. A mailbox in the `ready` state (zero-access) has no row here and is
-- untouched by this table.
--
-- Additive only. Rows are written and read by the privileged pool alone: RLS is
-- enabled and forced with no policy, so the request role sees nothing, and the
-- table is never granted to the read-only role. A full export keeps it: a
-- restore needs these keys to read managed mail, and they are useless without
-- ENCRYPTION_KEY, which is never in the database.
CREATE TABLE IF NOT EXISTS kernel.mailbox_server_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  wrapped_key text NOT NULL,
  kek_ref text NOT NULL DEFAULT 'env',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT mailbox_server_keys_version_byte CHECK (key_version BETWEEN 0 AND 255),
  CONSTRAINT mailbox_server_keys_status CHECK (status IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_server_keys_active
  ON kernel.mailbox_server_keys (account_id) WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_server_keys_version
  ON kernel.mailbox_server_keys (account_id, key_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mailbox_server_keys_org
  ON kernel.mailbox_server_keys (org_id);
--> statement-breakpoint
ALTER TABLE kernel.mailbox_server_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_server_keys FORCE ROW LEVEL SECURITY;
