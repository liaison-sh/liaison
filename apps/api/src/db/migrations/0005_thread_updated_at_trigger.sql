-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Thread recency must ALWAYS reflect the latest message activity.
-- Several insert paths (bulk importers, backfills, system notifiers) write
-- kernel.messages without bumping kernel.threads.updated_at, which breaks
-- the thread list's most-recent-activity-first ordering. Enforce the
-- invariant at the database level so no code path can skip it.

-- SECURITY DEFINER: the trigger must be able to update the thread row even
-- when the inserting role is constrained by RLS on kernel.threads.
CREATE OR REPLACE FUNCTION kernel.messages_bump_thread_updated_at_fn() RETURNS TRIGGER AS $TRIGGER_BODY$
BEGIN
  UPDATE kernel.threads
  SET updated_at = GREATEST(updated_at, NEW.created_at)
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS bump_thread_updated_at ON kernel.messages;
CREATE TRIGGER bump_thread_updated_at
AFTER INSERT ON kernel.messages
FOR EACH ROW EXECUTE FUNCTION kernel.messages_bump_thread_updated_at_fn();

-- Backfill: repair threads whose updated_at lags their newest message
-- (e.g. Slack-imported channels that kept receiving messages).
UPDATE kernel.threads t
SET updated_at = m.last_message_at
FROM (
  SELECT thread_id, MAX(created_at) AS last_message_at
  FROM kernel.messages
  GROUP BY thread_id
) m
WHERE m.thread_id = t.id
  AND m.last_message_at > t.updated_at;
