-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Deploy-time transition: every existing personal mail account moves to
-- pending_enrollment, which stops its sync until the owner enrols.
--
-- Those mailboxes stop receiving new mail until the user enrols. That is
-- deliberate: a mailbox that keeps writing plaintext while the product page
-- claims zero access is the one outcome no wording can make honest. Nothing is
-- lost, the messages stay at the provider.
--
-- Idempotent by the `= 'none'` predicate.
--
-- This migration is the fast path for a database where the column already exists.
-- On the deploy that introduces the feature it will NORMALLY no-op, because the
-- migrate one-shot runs before the app containers are recreated and the column is
-- created by the app schema sync. A no-opped migration still records its journal
-- row and never runs again, so `assertMailboxSchemaState` re-runs this same
-- statement after every schema sync. That boot step is what actually flips the
-- fleet; this file is the shortcut.

DO $$
BEGIN
  IF to_regclass('app_mail.accounts') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'accounts' AND column_name = 'encryption_state'
  ) THEN
    RETURN;
  END IF;
  UPDATE app_mail.accounts
     SET encryption_state = 'pending_enrollment'
   WHERE owner_type = 'user' AND encryption_state = 'none';
END $$;
