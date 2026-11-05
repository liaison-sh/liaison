-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Attachment sealing: the kernel.files encryption columns (spec sections 3.5, 5.8).
--
-- Additive and nullable except `enc_version`, whose 0 default means "these bytes
-- are stored as they arrived". A sealed attachment carries the wrapped content
-- key, the ephemeral public key it was wrapped against, the identity key id, and
-- the three STREAM values the client needs to map a plaintext range onto chunk
-- indices: chunk size, authenticated chunk count and authenticated plaintext
-- length, plus the 7 byte nonce prefix.
--
-- Filename and MIME type stay cleartext on purpose: they are envelope level and
-- the attachment list renders them without a key.
--
-- STORAGE EXTERNAL: migration 0032 already carries the statements for
-- content_key_wrapped, content_key_epk and nonce_prefix, but it ran BEFORE these
-- columns existed and therefore no-opped on them. It is guarded on the column
-- existing, so it cannot be re-run to catch up; the clauses are applied here
-- instead, and the two files must stay in sync.

ALTER TABLE kernel.files
  ADD COLUMN IF NOT EXISTS enc_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS content_key_wrapped bytea,
  ADD COLUMN IF NOT EXISTS content_key_epk bytea,
  ADD COLUMN IF NOT EXISTS enc_key_id smallint,
  ADD COLUMN IF NOT EXISTS chunk_size integer,
  ADD COLUMN IF NOT EXISTS chunk_count integer,
  ADD COLUMN IF NOT EXISTS plaintext_length bigint,
  ADD COLUMN IF NOT EXISTS nonce_prefix bytea;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'kernel.files'::regclass AND conname = 'files_enc_key_id_byte'
  ) THEN
    ALTER TABLE kernel.files
      ADD CONSTRAINT files_enc_key_id_byte CHECK (enc_key_id BETWEEN 0 AND 255);
  END IF;
END $$;

ALTER TABLE kernel.files ALTER COLUMN content_key_wrapped SET STORAGE EXTERNAL;
ALTER TABLE kernel.files ALTER COLUMN content_key_epk SET STORAGE EXTERNAL;
ALTER TABLE kernel.files ALTER COLUMN nonce_prefix SET STORAGE EXTERNAL;
