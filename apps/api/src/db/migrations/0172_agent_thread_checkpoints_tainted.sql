-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A checkpoint version records whether the region it summarises (or the
-- version it folds forward) carried outside text: a turn that renders the
-- summary reads that text again, so it is marked as a turn that read outside
-- text (modules/agent/scopes/replayed-outside-text.ts).
--
-- Rows written before this column default to false. The flag DEFINES what a
-- version carries, so it joins the columns the immutability trigger guards.
-- Re-runnable.
ALTER TABLE kernel.agent_thread_checkpoints
  ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kernel.agent_thread_checkpoint_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.upto_message_id IS DISTINCT FROM OLD.upto_message_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.required_scopes IS DISTINCT FROM OLD.required_scopes
     OR NEW.tainted IS DISTINCT FROM OLD.tainted THEN
    RAISE EXCEPTION 'agent_thread_checkpoints version rows are immutable: write a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
