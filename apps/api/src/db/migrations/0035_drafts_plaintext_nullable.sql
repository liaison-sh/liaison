-- SPDX-License-Identifier: FSL-1.1-ALv2
-- app_mail.drafts.subject / html_body / text_body were emitted NOT NULL DEFAULT ''.
--
-- A sealed draft has no plaintext to store, the Invariant P trigger has to be able
-- to see absence rather than a blank string, and the Phase 12 purge writes NULL over
-- these columns. All three are impossible while the columns are NOT NULL.
--
-- The DEFAULT matters as much as the NOT NULL: an insert that omits the column would
-- otherwise still store '', and the next writer after a purge would reinstate it.
--
-- Existing rows keep ''. Rewriting them is a needless full-table update: the trigger
-- compares NULLIF(NEW.c, '') and the purge writes NULL, so both read '' as absence.
--
-- Guarded, and re-asserted by `assertMailboxSchemaState` after every schema sync,
-- because on the deploy that introduces the feature the migrate one-shot runs before
-- the app containers are recreated.

DO $$
BEGIN
  IF to_regclass('app_mail.drafts') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'subject'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN subject DROP NOT NULL;
    ALTER TABLE app_mail.drafts ALTER COLUMN subject DROP DEFAULT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'html_body'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN html_body DROP NOT NULL;
    ALTER TABLE app_mail.drafts ALTER COLUMN html_body DROP DEFAULT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'text_body'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN text_body DROP NOT NULL;
    ALTER TABLE app_mail.drafts ALTER COLUMN text_body DROP DEFAULT;
  END IF;
END $$;
