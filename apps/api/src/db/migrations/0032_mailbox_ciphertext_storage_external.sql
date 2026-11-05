-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Mailbox ciphertext columns: STORAGE EXTERNAL.
--
-- The app-manifest DDL generator emits ADD COLUMN and no storage clause, so the
-- ciphertext columns would otherwise inherit the default EXTENDED: TOAST would
-- try to compress payloads that are, by construction, incompressible, and a
-- range or substring fetch on a wide value would have to fetch and decompress
-- the whole thing. EXTERNAL stores them out of line, uncompressed.
--
-- SET STORAGE governs newly written values only. That is correct here: these
-- columns are new, so every value they will ever hold is written after this.
--
-- Ordering: on a cold boot this migration runs BEFORE the mail app registers
-- and creates its schema, so every statement is guarded on the table and the
-- column actually existing. The startup assertion added later re-applies it
-- after the schema sync.

DO $$
BEGIN
  IF to_regclass('app_mail.messages') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'text_body_ciphertext'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN text_body_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'html_body_ciphertext'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN html_body_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'subject_ciphertext'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN subject_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'snippet_ciphertext'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN snippet_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'raw_headers_ciphertext'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN raw_headers_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'content_key_wrapped'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN content_key_wrapped SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'messages' AND column_name = 'content_key_epk'
  ) THEN
    ALTER TABLE app_mail.messages ALTER COLUMN content_key_epk SET STORAGE EXTERNAL;
  END IF;
END $$;
DO $$
BEGIN
  IF to_regclass('app_mail.conversations') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'conversations' AND column_name = 'subject_ciphertext'
  ) THEN
    ALTER TABLE app_mail.conversations ALTER COLUMN subject_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'conversations' AND column_name = 'snippet_ciphertext'
  ) THEN
    ALTER TABLE app_mail.conversations ALTER COLUMN snippet_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'conversations' AND column_name = 'content_key_wrapped'
  ) THEN
    ALTER TABLE app_mail.conversations ALTER COLUMN content_key_wrapped SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'conversations' AND column_name = 'content_key_epk'
  ) THEN
    ALTER TABLE app_mail.conversations ALTER COLUMN content_key_epk SET STORAGE EXTERNAL;
  END IF;
END $$;
DO $$
BEGIN
  IF to_regclass('app_mail.drafts') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'body_ciphertext'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN body_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'subject_ciphertext'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN subject_ciphertext SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'content_key_wrapped'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN content_key_wrapped SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_mail' AND table_name = 'drafts' AND column_name = 'content_key_epk'
  ) THEN
    ALTER TABLE app_mail.drafts ALTER COLUMN content_key_epk SET STORAGE EXTERNAL;
  END IF;
END $$;
DO $$
BEGIN
  IF to_regclass('kernel.files') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kernel' AND table_name = 'files' AND column_name = 'content_key_wrapped'
  ) THEN
    ALTER TABLE kernel.files ALTER COLUMN content_key_wrapped SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kernel' AND table_name = 'files' AND column_name = 'content_key_epk'
  ) THEN
    ALTER TABLE kernel.files ALTER COLUMN content_key_epk SET STORAGE EXTERNAL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kernel' AND table_name = 'files' AND column_name = 'nonce_prefix'
  ) THEN
    ALTER TABLE kernel.files ALTER COLUMN nonce_prefix SET STORAGE EXTERNAL;
  END IF;
END $$;
