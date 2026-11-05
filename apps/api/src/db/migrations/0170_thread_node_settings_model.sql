-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The model a conversation's node chat runs on (My node).
--
-- Null: the agent's own model preference, as before. A model id is one the
-- conversation's node offered when it was picked; the node still runs it only
-- when its Claude offers it, else its family's current model. The id is a
-- plain Claude model name, never free text the node would pass through.
-- Re-runnable.
ALTER TABLE kernel.thread_node_settings ADD COLUMN IF NOT EXISTS model text;
--> statement-breakpoint
ALTER TABLE kernel.thread_node_settings DROP CONSTRAINT IF EXISTS thread_node_settings_model_check;
--> statement-breakpoint
ALTER TABLE kernel.thread_node_settings
  ADD CONSTRAINT thread_node_settings_model_check
  CHECK (model IS NULL OR model ~ '^claude-[a-z0-9][][a-z0-9.-]{0,63}$');
