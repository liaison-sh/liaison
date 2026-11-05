-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An HONEST witness that the destructive purge ran.
--
-- `plaintext_purged_at` is stamped only when the cutover is COMPLETE, which
-- means every personal-mail attachment object is sealed too. Nothing seals
-- historical attachment bytes, so on a real pre-existing mailbox that condition
-- is false and the column stays NULL after a purge that has already NULLed
-- every subject, body and snippet and reduced every raw_headers. An operator
-- re-checking the ledger the next day reads NULL and concludes the purge never
-- ran, when in fact the only readable copies left are inside compliance-locked
-- backups.
--
-- This column records the DESTRUCTION, unconditionally. It is not a completion
-- flag and must never be read as one: `plaintext_purged_at` keeps that meaning
-- exactly as it is, and the refusal to stamp it while attachments are unsealed
-- is correct and stays.
--
--   plaintext_purge_ran_at IS NOT NULL  -> plaintext was destroyed, no undo
--   plaintext_purged_at    IS NOT NULL  -> and the cutover is complete
ALTER TABLE kernel.mailbox_migration_state
  ADD COLUMN IF NOT EXISTS plaintext_purge_ran_at timestamptz;
--> statement-breakpoint
-- Any mailbox that reached the completion stamp on an earlier build obviously
-- also ran the destructive purge, so backfill the new column from it. Rows
-- purged while incomplete cannot be recovered this way; there were none in
-- production when this shipped, and the honest answer for a hypothetical one is
-- NULL rather than a fabricated timestamp.
UPDATE kernel.mailbox_migration_state
   SET plaintext_purge_ran_at = plaintext_purged_at
 WHERE plaintext_purged_at IS NOT NULL AND plaintext_purge_ran_at IS NULL;
