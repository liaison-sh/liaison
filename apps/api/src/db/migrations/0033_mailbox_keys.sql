-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Zero-access mailbox encryption: the control-plane key tables.
--
-- Four tables: the public keyring, the wrapped Account Keys, the per-user
-- cutover ledger and the headless client job queue. Every column a later phase
-- needs is declared HERE, the first time. Once this file has run its hash is in
-- the drizzle ledger of every dev, test and CI database, so editing it later to
-- add a column would never execute while the file claimed otherwise: a
-- genuinely late-discovered column gets its own numbered migration.
--
-- Every statement here is RE-RUNNABLE. That is not decoration: this file's
-- journal `when` was raised above the already-deployed 0038 so the drizzle
-- ledger highwater cannot skip it, which means any database that already
-- applied it under the old (too-low) `when` will apply it a second time.
-- CREATE TABLE / CREATE INDEX carry IF NOT EXISTS, ENABLE/FORCE ROW LEVEL
-- SECURITY and GRANT are naturally idempotent, and CREATE POLICY is not, so
-- each policy is dropped by name first. Keep it that way.
--
-- RLS notes, both of them traps this codebase has already been bitten by:
--   * Every GUC cast goes through `nullif(current_setting(...), '')::uuid`. A
--     bare `''::uuid` raises 22P02 and ABORTS the query before the policy can
--     evaluate to deny, so the failure mode is a hard error on an unrelated
--     code path rather than a clean zero rows.
--   * `FORCE ROW LEVEL SECURITY` as well as `ENABLE`, so the table owner is not
--     silently exempt.

CREATE TABLE IF NOT EXISTS kernel.user_mailbox_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  -- One byte in the ciphertext blob header. A value above 255 is a schema
  -- error, not something to truncate silently at seal time.
  key_id smallint NOT NULL,
  ecdh_public_key bytea NOT NULL,
  sign_public_key bytea NOT NULL,
  keyring_attestation bytea NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT user_mailbox_identities_key_id_byte CHECK (key_id BETWEEN 0 AND 255),
  CONSTRAINT user_mailbox_identities_status CHECK (status IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mailbox_identities_user_key
  ON kernel.user_mailbox_identities (user_id, key_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_mailbox_identities_user_status
  ON kernel.user_mailbox_identities (user_id, status);
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A SPLIT pair, deliberately.
--
-- The owner writes their own rows; any authenticated member of the same org may
-- READ them, because sealing mail for a colleague needs their ECDH public key
-- and verifying their keyring needs their signing public key, and a public key
-- is public by definition. Postgres has no column-level RLS, so the org-read
-- exposure is the whole row: that is acceptable only because every column on
-- this table is public key material or status. Never add a private column here.
--
-- The consequence is stated rather than hidden: a readable public key means any
-- org member can WRITE a row this user can decrypt. Detection, not prevention,
-- is the answer (the keyring attestation and the downgrade detector).
DROP POLICY IF EXISTS user_mailbox_identities_owner ON kernel.user_mailbox_identities;
--> statement-breakpoint
CREATE POLICY user_mailbox_identities_owner ON kernel.user_mailbox_identities FOR ALL TO liaison_rls
  USING (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS user_mailbox_identities_org_read ON kernel.user_mailbox_identities;
--> statement-breakpoint
CREATE POLICY user_mailbox_identities_org_read ON kernel.user_mailbox_identities FOR SELECT TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.user_key_wraps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  wrap_type text NOT NULL,
  credential_id bytea,
  label text,
  -- OFFLINE CRACKING ORACLE at Argon2id speed. Owner only, for every
  -- operation. It must never reach an admin tool, an export, a database
  -- connector, a log line, or the liaison_readonly role (T-SEC-2). It being
  -- opaque is not a reason to relax any of that.
  wrapped_account_key bytea NOT NULL,
  kdf_params jsonb,
  verifier bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT user_key_wraps_type CHECK (wrap_type IN ('passkey_prf', 'recovery_phrase', 'passphrase'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_key_wraps_user
  ON kernel.user_key_wraps (user_id, created_at);
--> statement-breakpoint
ALTER TABLE kernel.user_key_wraps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_key_wraps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS user_key_wraps_owner ON kernel.user_key_wraps;
--> statement-breakpoint
CREATE POLICY user_key_wraps_owner ON kernel.user_key_wraps FOR ALL TO liaison_rls
  USING (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.mailbox_migration_state (
  user_id uuid PRIMARY KEY REFERENCES kernel.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  enrolled_at timestamptz,
  backfill_started_at timestamptz,
  backfill_completed_at timestamptz,
  backfill_cursor jsonb,
  messages_total bigint,
  messages_sealed bigint,
  verify_nonce bytea,
  verify_nonce_issued_at timestamptz,
  client_verified_at timestamptz,
  client_ack_signature bytea,
  client_ack_id_digest bytea,
  client_ack_count bigint,
  client_ack_key_id smallint,
  plaintext_purged_at timestamptz,
  derivatives_purged_at timestamptz,
  meili_purged_at timestamptz,
  -- Until this instant the backups still hold plaintext. Recorded, not assumed:
  -- it is the one cost this feature cannot undo.
  backups_clear_after timestamptz
);
--> statement-breakpoint
ALTER TABLE kernel.mailbox_migration_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_migration_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mailbox_migration_state_owner ON kernel.mailbox_migration_state;
--> statement-breakpoint
CREATE POLICY mailbox_migration_state_owner ON kernel.mailbox_migration_state FOR ALL TO liaison_rls
  USING (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.mailbox_client_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  account_id uuid,
  kind text NOT NULL,
  -- Envelope level ONLY. Never a body, never a body excerpt, never a subject:
  -- this is control-plane state and Invariant K applies to it in full.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  claimed_by_session text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  result_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_client_jobs_status CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mailbox_client_jobs_user_status
  ON kernel.mailbox_client_jobs (user_id, status, created_at);
--> statement-breakpoint
ALTER TABLE kernel.mailbox_client_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_client_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mailbox_client_jobs_owner ON kernel.mailbox_client_jobs;
--> statement-breakpoint
CREATE POLICY mailbox_client_jobs_owner ON kernel.mailbox_client_jobs FOR ALL TO liaison_rls
  USING (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );
--> statement-breakpoint

-- The ciphertext columns are wide and incompressible: store them out of line
-- and skip the compressor, exactly as migration 0032 does for app_mail.
ALTER TABLE kernel.user_key_wraps ALTER COLUMN wrapped_account_key SET STORAGE EXTERNAL;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_client_jobs ALTER COLUMN result_ciphertext SET STORAGE EXTERNAL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.user_mailbox_identities TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.user_key_wraps TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.mailbox_migration_state TO liaison_rls, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.mailbox_client_jobs TO liaison_rls, liaison_app;
