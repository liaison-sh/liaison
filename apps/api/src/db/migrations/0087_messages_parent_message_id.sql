-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P3b-T01: `kernel.messages` gains a nullable self referencing parent.
--
-- One column carries both the nesting Home renders and every dispatch guard:
-- hop depth is the number of agent authored links in the parent chain, the root
-- turn is that chain's topmost row, the per root cap counts agent authored
-- descendants of the root, and the dedupe is a scan of siblings under one
-- parent. No new table, no hop_depth column, no root_turn_id column.
--
-- `parent_message_id IS NULL` is the audience asymmetry: a human facing turn is
-- flattened to the thread root, an agent only turn nests.
--
-- A PLAIN self foreign key, deliberately NOT the composite
-- (parent_message_id, org_id) that keys into kernel.agents carry: that
-- composite exists because agents is an org scoped PRINCIPAL table, reachable
-- from a row in another org. A self key inside messages cannot cross orgs,
-- because thread_id already pins the org of every row in a thread.
--
-- ON DELETE CASCADE: a nested answer has no meaning once the question it hangs
-- under is gone.
ALTER TABLE kernel.messages
  ADD COLUMN IF NOT EXISTS parent_message_id uuid;

ALTER TABLE kernel.messages
  DROP CONSTRAINT IF EXISTS messages_parent_message_fk;

ALTER TABLE kernel.messages
  ADD CONSTRAINT messages_parent_message_fk
  FOREIGN KEY (parent_message_id) REFERENCES kernel.messages(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS messages_parent_idx
  ON kernel.messages (parent_message_id)
  WHERE parent_message_id IS NOT NULL;
