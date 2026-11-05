-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Finish what 0116 deferred: merge duplicate mail rows and build the two
-- uniques the mail writes depend on.
--
-- 0116 falls back to NON-unique indexes when a deployment already holds
-- duplicate (account, external_message_id) or (account, external_thread_id)
-- keys. But the sync's page insert and the sent-mail record both write with
-- ON CONFLICT on those columns, and Postgres refuses an ON CONFLICT target
-- with no matching unique (42P10). On such a deployment (one seen 2026-10-01:
-- one duplicate pair of each, from a racing import on 2026-09-14) every Gmail
-- incremental sync failed and every approved mail:compose was sent by Gmail
-- and then parked "ambiguous" because recording it failed.
--
-- The duplicates are true duplicates (same provider id, same account), so the
-- OLDEST row of each key is kept and the others are merged into it:
--   1. messages: a duplicate's files move to the kept message, then the
--      duplicate is deleted.
--   2. conversations: messages, drafts and files move to the kept
--      conversation, its message_count is recounted, the duplicate is deleted.
--   3. the uniques are built under 0116's `_key` names and its `_idx`
--      fallbacks are dropped.
-- Locking as 0116: SHARE ROW EXCLUSIVE on both tables (no write can slip a new
-- duplicate in between the merge and the build), bounded by lock_timeout so a
-- busy sync fails the migration cleanly instead of queueing behind it.
-- Idempotent: on clean data steps 1 and 2 touch nothing and IF NOT EXISTS / IF
-- EXISTS make step 3 a no-op.
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '30s', true);
  LOCK TABLE app_mail.messages, app_mail.conversations, app_mail.drafts IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE _mail_dup_messages ON COMMIT DROP AS
    SELECT id AS dup_id, keep_id FROM (
      SELECT id, first_value(id) OVER (
               PARTITION BY org_id, account_id, external_message_id
               ORDER BY created_at, id) AS keep_id
        FROM app_mail.messages
       WHERE external_message_id IS NOT NULL
    ) ranked
    WHERE id <> keep_id;
  UPDATE kernel.files f SET entity_id = d.keep_id::text
    FROM _mail_dup_messages d WHERE f.entity_id = d.dup_id::text;
  DELETE FROM app_mail.messages m USING _mail_dup_messages d WHERE m.id = d.dup_id;

  CREATE TEMP TABLE _mail_dup_conversations ON COMMIT DROP AS
    SELECT id AS dup_id, keep_id FROM (
      SELECT id, first_value(id) OVER (
               PARTITION BY org_id, account_id, external_thread_id
               ORDER BY created_at, id) AS keep_id
        FROM app_mail.conversations
    ) ranked
    WHERE id <> keep_id;
  UPDATE app_mail.messages m SET conversation_id = d.keep_id
    FROM _mail_dup_conversations d WHERE m.conversation_id = d.dup_id;
  UPDATE app_mail.drafts r SET conversation_id = d.keep_id
    FROM _mail_dup_conversations d WHERE r.conversation_id = d.dup_id;
  UPDATE kernel.files f SET entity_id = d.keep_id::text
    FROM _mail_dup_conversations d WHERE f.entity_id = d.dup_id::text;
  DELETE FROM app_mail.conversations c USING _mail_dup_conversations d WHERE c.id = d.dup_id;
  UPDATE app_mail.conversations c
     SET message_count = (SELECT count(*) FROM app_mail.messages m WHERE m.conversation_id = c.id)
   WHERE c.id IN (SELECT DISTINCT keep_id FROM _mail_dup_conversations);

  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS messages_org_id_account_id_external_message_id_key '
    'ON app_mail.messages (org_id, account_id, external_message_id)';
  EXECUTE 'DROP INDEX IF EXISTS app_mail.messages_org_id_account_id_external_message_id_idx';
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS conversations_org_id_account_id_external_thread_id_key '
    'ON app_mail.conversations (org_id, account_id, external_thread_id)';
  EXECUTE 'DROP INDEX IF EXISTS app_mail.conversations_org_id_account_id_external_thread_id_idx';
END $$;
