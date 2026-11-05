-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The durable copy of the identity keyring's PRIVATE halves.
--
-- Migration 0033 stored only the public halves, which left the private halves
-- living in one browser's localStorage. That inverted the whole design: a fresh
-- browser profile could never unlock, and clearing site data destroyed the
-- mailbox permanently even when the account holder still had their recovery
-- phrase. The phrase recovers the Account Key, and an Account Key opens nothing
-- on its own, so the loss was total and silent.
--
-- Storing them here concedes NOTHING to the server. All four values are
-- ciphertext: each private half is AES-GCM wrapped under the user's Account Key
-- with an AAD bound to the blob header, the user id, the key id and which half
-- it is (`liaison.mailbox.keyring:<user>:<keyId>:<ecdh|sign>`), and the Account
-- Key exists only in the account holder's browser. The server therefore holds
-- bytes it has no key for and no oracle against: unlike a wrapped Account Key,
-- which is grindable at Argon2id speed behind a passphrase, these sit behind a
-- 256-bit random key that is never derived from anything a person types.
--
-- NULLABLE on purpose. Rows enrolled before this migration have no wrapped
-- privates on the server, and those users' browsers still hold their local
-- copy; the read path skips a partial row rather than half building an entry
-- that could never be unwrapped. Making the columns NOT NULL would break every
-- one of those rows for no gain.
--
-- 0033's `user_mailbox_identities_org_read` policy says "Never add a private
-- column here", and this migration is the deliberate, reasoned exception rather
-- than an oversight. Postgres has no column-level RLS, so an org member who can
-- read a colleague's public keys can now also read these four blobs. What they
-- get is ciphertext under a key they do not have and cannot grind, which is a
-- strictly smaller exposure than the public keys already granted by the same
-- policy: a public key lets an org member WRITE a row the owner will decrypt,
-- while these let them do nothing at all. The rule the original comment was
-- protecting is "no PLAINTEXT private material", and that still holds absolutely.
--
-- Reach: these columns are treated exactly as `kernel.user_key_wraps` is. They
-- are never granted to `liaison_readonly` (this table is not mentioned in the
-- grants file at all) and the table's DATA is excluded from `export-full`, so
-- no admin tool, connector or export artifact carries them.
ALTER TABLE kernel.user_mailbox_identities
  ADD COLUMN IF NOT EXISTS wrapped_ecdh_private bytea;
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities
  ADD COLUMN IF NOT EXISTS wrapped_sign_private bytea;
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities
  ADD COLUMN IF NOT EXISTS ecdh_wrap_iv bytea;
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities
  ADD COLUMN IF NOT EXISTS sign_wrap_iv bytea;
--> statement-breakpoint
-- Ciphertext, so out of line and uncompressed like every other sealed column
-- (see 0032): TOAST compression on a random-looking blob costs CPU and saves
-- nothing.
ALTER TABLE kernel.user_mailbox_identities
  ALTER COLUMN wrapped_ecdh_private SET STORAGE EXTERNAL;
--> statement-breakpoint
ALTER TABLE kernel.user_mailbox_identities
  ALTER COLUMN wrapped_sign_private SET STORAGE EXTERNAL;
