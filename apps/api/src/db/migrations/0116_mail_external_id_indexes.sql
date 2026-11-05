-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Index the mail sync's dedupe keys. Every synced message looked itself up by
-- (account, external_message_id), its thread by (account, external_thread_id),
-- and every Gmail page, history replay, deletion and label change by
-- (account, external_provider_id). None of the three was indexed, so each
-- lookup was a sequential scan and importing a mailbox was quadratic in its
-- size (production, 2026-09-30: 106.6M tuples read to import 10k messages).
--
-- The mail manifest has always DECLARED the two uniques, but array-form
-- uniques are emitted only by CREATE TABLE, and 0000 creates these tables
-- first, so no deployment ever got them. The names below are the ones Postgres
-- gives the manifest's CREATE TABLE constraints, so a runtime-created table
-- (an e2e worker schema) and a migrated one end up with the same index names.
--
-- The uniques are what let the sync insert a page with ON CONFLICT DO NOTHING:
-- a racing writer's row wins instead of a duplicate being stored. If a
-- deployment already holds duplicates, a unique index cannot be built and this
-- migration must not fail its deploy for it: it builds the same columns
-- NON-unique under a distinct `_idx` name (the lookups still get their index)
-- and raises a WARNING with the count, so the data can be cleaned and the
-- unique added by a later migration. Production held none when this was
-- written (10,000 messages / 5,730 conversations, 0 duplicate keys).
--
-- Locking: the migrator runs every file in one transaction, so CONCURRENTLY
-- is not available. Both tables are locked IN SHARE MODE first (the lock a
-- CREATE INDEX takes anyway: writes wait, reads do not), so no insert can land
-- between the duplicate check and the build and turn a clean check into a
-- failed unique build. `lock_timeout` bounds the wait for that lock behind a
-- running sync transaction (each is one short bridge call): past it the
-- migration fails cleanly and the deploy can simply be retried, instead of
-- queueing every mail write behind it indefinitely. At production's size
-- (16 MB messages heap, 4 MB conversations) the builds take well under a
-- second. Idempotent: IF NOT EXISTS throughout.
DO $$
DECLARE
  _dupes bigint;
BEGIN
  PERFORM set_config('lock_timeout', '30s', true);
  LOCK TABLE app_mail.messages, app_mail.conversations IN SHARE MODE;
  SELECT count(*) INTO _dupes FROM (
    SELECT 1 FROM app_mail.messages
     WHERE external_message_id IS NOT NULL
     GROUP BY org_id, account_id, external_message_id HAVING count(*) > 1
  ) d;
  IF _dupes = 0 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS messages_org_id_account_id_external_message_id_key '
      'ON app_mail.messages (org_id, account_id, external_message_id)';
  ELSE
    RAISE WARNING 'app_mail.messages holds % duplicate (account, external_message_id) keys: indexing without uniqueness', _dupes;
    EXECUTE 'CREATE INDEX IF NOT EXISTS messages_org_id_account_id_external_message_id_idx '
      'ON app_mail.messages (org_id, account_id, external_message_id)';
  END IF;

  SELECT count(*) INTO _dupes FROM (
    SELECT 1 FROM app_mail.conversations
     GROUP BY org_id, account_id, external_thread_id HAVING count(*) > 1
  ) d;
  IF _dupes = 0 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS conversations_org_id_account_id_external_thread_id_key '
      'ON app_mail.conversations (org_id, account_id, external_thread_id)';
  ELSE
    RAISE WARNING 'app_mail.conversations holds % duplicate (account, external_thread_id) keys: indexing without uniqueness', _dupes;
    EXECUTE 'CREATE INDEX IF NOT EXISTS conversations_org_id_account_id_external_thread_id_idx '
      'ON app_mail.conversations (org_id, account_id, external_thread_id)';
  END IF;

  -- Not unique: a provider id is only unique per provider mailbox, and sent
  -- messages reuse the RFC Message-ID as their provider id.
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_app_mail_messages_account_id_external_provider_id '
    'ON app_mail.messages (org_id, account_id, external_provider_id)';
END $$;
