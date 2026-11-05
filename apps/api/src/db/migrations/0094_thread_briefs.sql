-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4c-T49: the brief is not a blob, it is ROWS.
--
-- A rolling summary answers "roughly what happened" and nothing else. The
-- question a conversation actually asks of its own past is "what is the CURRENT
-- value of this thing", and a paragraph cannot answer that: the old value and
-- the new one sit in the same prose, and the reader picks whichever it noticed.
--
-- So a brief is a set of LINES, each one a row: a decision, an open loop, an
-- identifier, a procedure, a contradiction. Each carries the key it is about,
-- the value it currently has, the messages it came from, and a status. A line
-- whose value changes does not overwrite the old line: the old row becomes
-- `superseded` and points at the row that replaced it, so "what is current" is
-- a lookup and "what did it used to say" is still on disk.
--
-- KEYED BY THREAD, NOT BY AGENT. A decision taken in a conversation is a fact
-- of the CONVERSATION. Two agents sitting in one room did not take two
-- decisions. So the rows are written once per region, by whichever agent's
-- checkpoint advance reaches that region first (kernel.thread_brief_marks says
-- how far the extraction has run), and every agent then renders its OWN core
-- from the same rows, filtered by its own join point and ceiling. That is the
-- one place the per-agent rule still applies: what an agent may SEE, never what
-- the conversation contains.
--
-- EPISODES ARE FETCHED, NOT FED. kernel.thread_episodes holds a short body per
-- closed stretch of conversation. It is never folded into a prompt by default;
-- an agent that wants one calls memory_episode with its id. A brief that fed
-- every episode forward would grow without bound, which is the blob again.
--
-- Every statement is re-runnable, following the 0033/0045/0082/0089/0090
-- convention.

CREATE TABLE IF NOT EXISTS kernel.thread_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  -- A text column with a CHECK rather than a pg enum: an enum is a type change
  -- to add a value to, and the vocabulary here is product vocabulary that will
  -- gain a kind before it loses one.
  kind text NOT NULL CHECK (kind IN ('decision', 'open_loop', 'identifier', 'procedure', 'contradiction')),
  -- What the line is ABOUT ("the DHL account number", "ship date for order
  -- 1042"). Supersession is keyed on it, so it is the stable half of the line.
  key text NOT NULL,
  -- What the line SAYS right now. The half that gets superseded.
  value text NOT NULL,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'closed')),
  -- The row that replaced this one. Self-referential and nullable: a `current`
  -- row points at nothing, and the chain reads newest-last.
  superseded_by uuid REFERENCES kernel.thread_briefs(id) ON DELETE SET NULL,
  -- Every message this line was drawn from, so a hit can be opened verbatim.
  message_ids uuid[] NOT NULL DEFAULT '{}',
  -- The EARLIEST of those messages. This is the ordering key of the whole
  -- table: "which value is newer" is decided by where the line's first message
  -- sits in the thread, never by a model's opinion of which looks fresher.
  first_message_id uuid NOT NULL,
  region_start_message_id uuid,
  region_end_message_id uuid,
  written_by_agent_id uuid,
  -- Set on an open loop once its closure appears in the conversation.
  closing_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ONE ROW PER (thread, kind, key, first message). Re-extracting the same region
-- (two agents advancing over it, a retry, a replay) must converge on the same
-- rows rather than pile up duplicates of one decision, and the first message is
-- what makes two extractions of the SAME line the same line while leaving a
-- genuinely later value its own row.
CREATE UNIQUE INDEX IF NOT EXISTS thread_briefs_thread_kind_key_first_idx
  ON kernel.thread_briefs (thread_id, kind, key, first_message_id);
--> statement-breakpoint

-- The core render: one thread, the current rows, newest first.
CREATE INDEX IF NOT EXISTS thread_briefs_thread_status_idx
  ON kernel.thread_briefs (thread_id, status);
--> statement-breakpoint

-- The supersession chain walk for one key.
CREATE INDEX IF NOT EXISTS thread_briefs_thread_kind_key_idx
  ON kernel.thread_briefs (thread_id, kind, key);
--> statement-breakpoint

ALTER TABLE kernel.thread_briefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_briefs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.thread_briefs TO liaison_rls, liaison_app;
--> statement-breakpoint

-- RLS is the org pin plus thread membership, the kernel.threads pattern 0090
-- follows: a brief row says something about a conversation, so whoever may see
-- the conversation may see its rows and nobody else. The WRITER is the
-- checkpoint advance, which runs privileged (BYPASSRLS) because it writes on
-- behalf of an agent, not of whoever happened to post the last message.
DROP POLICY IF EXISTS thread_briefs_select ON kernel.thread_briefs;
--> statement-breakpoint
CREATE POLICY thread_briefs_select ON kernel.thread_briefs FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_briefs.thread_id
         AND tp.org_id = kernel.thread_briefs.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_briefs_insert ON kernel.thread_briefs;
--> statement-breakpoint
CREATE POLICY thread_briefs_insert ON kernel.thread_briefs FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_briefs.thread_id
         AND tp.org_id = kernel.thread_briefs.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_briefs_update ON kernel.thread_briefs;
--> statement-breakpoint
CREATE POLICY thread_briefs_update ON kernel.thread_briefs FOR UPDATE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS thread_briefs_delete ON kernel.thread_briefs;
--> statement-breakpoint
CREATE POLICY thread_briefs_delete ON kernel.thread_briefs FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_briefs.thread_id
         AND tp.org_id = kernel.thread_briefs.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- kernel.thread_episodes: one closed stretch of conversation, summarized once
-- and then LEFT THERE. The body is capped by the writer at
-- BRIEF_EPISODE_TOKEN_BUDGET (300 tokens); nothing reads it unless an agent
-- asks for it by id.
CREATE TABLE IF NOT EXISTS kernel.thread_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  title text NOT NULL,
  span_start_message_id uuid,
  span_end_message_id uuid,
  body text NOT NULL,
  message_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS thread_episodes_thread_created_idx
  ON kernel.thread_episodes (thread_id, created_at);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS thread_episodes_thread_span_idx
  ON kernel.thread_episodes (thread_id, span_start_message_id, span_end_message_id);
--> statement-breakpoint

ALTER TABLE kernel.thread_episodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_episodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.thread_episodes TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS thread_episodes_select ON kernel.thread_episodes;
--> statement-breakpoint
CREATE POLICY thread_episodes_select ON kernel.thread_episodes FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_episodes.thread_id
         AND tp.org_id = kernel.thread_episodes.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_episodes_insert ON kernel.thread_episodes;
--> statement-breakpoint
CREATE POLICY thread_episodes_insert ON kernel.thread_episodes FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_episodes.thread_id
         AND tp.org_id = kernel.thread_episodes.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_episodes_update ON kernel.thread_episodes;
--> statement-breakpoint
CREATE POLICY thread_episodes_update ON kernel.thread_episodes FOR UPDATE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS thread_episodes_delete ON kernel.thread_episodes;
--> statement-breakpoint
CREATE POLICY thread_episodes_delete ON kernel.thread_episodes FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_episodes.thread_id
         AND tp.org_id = kernel.thread_episodes.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- kernel.thread_brief_marks: how far row extraction has run on this thread.
-- ONE ROW PER THREAD, which is the whole point: the region between the mark and
-- the advance's boundary is extracted ONCE however many agents sit in the room,
-- and the second agent to advance over the same stretch finds the mark already
-- past it and extracts nothing.
CREATE TABLE IF NOT EXISTS kernel.thread_brief_marks (
  thread_id uuid PRIMARY KEY REFERENCES kernel.threads(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  extracted_upto_message_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE kernel.thread_brief_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_brief_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.thread_brief_marks TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS thread_brief_marks_select ON kernel.thread_brief_marks;
--> statement-breakpoint
CREATE POLICY thread_brief_marks_select ON kernel.thread_brief_marks FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_brief_marks.thread_id
         AND tp.org_id = kernel.thread_brief_marks.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_brief_marks_insert ON kernel.thread_brief_marks;
--> statement-breakpoint
CREATE POLICY thread_brief_marks_insert ON kernel.thread_brief_marks FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_brief_marks.thread_id
         AND tp.org_id = kernel.thread_brief_marks.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS thread_brief_marks_update ON kernel.thread_brief_marks;
--> statement-breakpoint
CREATE POLICY thread_brief_marks_update ON kernel.thread_brief_marks FOR UPDATE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS thread_brief_marks_delete ON kernel.thread_brief_marks;
--> statement-breakpoint
CREATE POLICY thread_brief_marks_delete ON kernel.thread_brief_marks FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.thread_brief_marks.thread_id
         AND tp.org_id = kernel.thread_brief_marks.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- THE FROZEN CORE. A checkpoint row carries the summary and nothing else free
-- form, so the core an agent rendered AT ADVANCE TIME needs a slot of its own.
-- Frozen rather than re-rendered per turn for the reason the whole checkpoint
-- exists (I3): a core that re-rendered would change bytes whenever a later
-- region superseded a line, and a prefix that changes is a cache miss on every
-- turn. Nullable, because every checkpoint written before this migration has no
-- core and a backfill would have to invent one.
ALTER TABLE kernel.agent_thread_checkpoints ADD COLUMN IF NOT EXISTS core_brief text;
