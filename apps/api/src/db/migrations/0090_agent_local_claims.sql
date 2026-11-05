-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_local_claims (A32, P6b-FX10): this machine is running that
-- agent's turns in that conversation, and the server is not.
--
-- A desktop local session's INPUT is the conversation it was started from. So
-- while the desktop is answering there, the server must not also answer: one
-- human message would otherwise produce two turns and two replies, one of them
-- from a runtime that cannot see the user's folder at all.
--
-- IT IS A LEASE, NOT A FLAG. `expires_at` is short and only the holding window
-- pushes it forward. A laptop that sleeps, a window that is closed, a process
-- that is killed all stop renewing, the claim lapses, and the thread goes back
-- to being answered by the server on its own. A flag would leave the
-- conversation permanently unanswered by the machine that set it.
--
-- ONE CLAIM PER (thread, agent). Two machines cannot both be the local runtime
-- for one agent in one conversation; the second registration takes the lease
-- over, which is the same thing a heartbeat does.
--
-- RLS is the org pin plus thread membership: a claim says something about a
-- conversation, so whoever may see the conversation may see the claim, and
-- nobody else. The DISPATCH GUARD reads it through the privileged connection,
-- because it runs on behalf of whoever posted the message and must see a claim
-- held by someone else in the room.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

CREATE TABLE IF NOT EXISTS kernel.agent_local_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kernel.agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS agent_local_claims_thread_agent_idx
  ON kernel.agent_local_claims (thread_id, agent_id);
--> statement-breakpoint

-- The guard's own read: one thread, every live claim on it.
CREATE INDEX IF NOT EXISTS agent_local_claims_thread_expiry_idx
  ON kernel.agent_local_claims (thread_id, expires_at);
--> statement-breakpoint

ALTER TABLE kernel.agent_local_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_local_claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agent_local_claims TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agent_local_claims_select ON kernel.agent_local_claims;
--> statement-breakpoint
CREATE POLICY agent_local_claims_select ON kernel.agent_local_claims FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.agent_local_claims.thread_id
         AND tp.org_id = kernel.agent_local_claims.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

-- A claim is taken by the person holding the session, on a conversation they
-- are in: a member of the room cannot claim it in someone else's name, and a
-- stranger to the room cannot claim it at all.
DROP POLICY IF EXISTS agent_local_claims_insert ON kernel.agent_local_claims;
--> statement-breakpoint
CREATE POLICY agent_local_claims_insert ON kernel.agent_local_claims FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.agent_local_claims.thread_id
         AND tp.org_id = kernel.agent_local_claims.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_local_claims_update ON kernel.agent_local_claims;
--> statement-breakpoint
CREATE POLICY agent_local_claims_update ON kernel.agent_local_claims FOR UPDATE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

-- A member of the room may release a claim, including one another machine left
-- behind: the alternative is a conversation nobody answers until the lease runs
-- out, with the only person who could fix it locked out of the row.
DROP POLICY IF EXISTS agent_local_claims_delete ON kernel.agent_local_claims;
--> statement-breakpoint
CREATE POLICY agent_local_claims_delete ON kernel.agent_local_claims FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
       WHERE tp.thread_id = kernel.agent_local_claims.thread_id
         AND tp.org_id = kernel.agent_local_claims.org_id
         AND tp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
