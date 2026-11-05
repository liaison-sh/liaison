-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The three values the purge needs to RE-VERIFY a stored acknowledgement.
--
-- Migration 0033 declared the acknowledgement columns the blueprint anticipated
-- (`client_ack_signature`, `client_ack_id_digest`, `client_ack_count`,
-- `client_ack_key_id`), but the Ed25519 statement of packages/mailbox-crypto
-- ack.ts binds three more values: the account id, the nonce and the backfill
-- cursor. Without them the signature can be verified once, at the moment it
-- arrives, and never again.
--
-- That is not good enough for the purge. The purge is irreversible and it runs
-- later, so it re-derives the digest over the rows it is about to destroy AND
-- re-checks the signature under the stored public key. A hand-written
-- `client_verified_at` must not be sufficient to authorise a destruction, and
-- re-verification is what makes it insufficient.
--
-- 0033's hash is already in the drizzle ledger of every dev, test and CI
-- database, so these arrive as their own numbered migration rather than as an
-- edit to it: an edit would never run while the file claimed otherwise.
ALTER TABLE kernel.mailbox_migration_state
  ADD COLUMN IF NOT EXISTS client_ack_account_id uuid;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_migration_state
  ADD COLUMN IF NOT EXISTS client_ack_nonce bytea;
--> statement-breakpoint
ALTER TABLE kernel.mailbox_migration_state
  ADD COLUMN IF NOT EXISTS client_ack_cursor text;
