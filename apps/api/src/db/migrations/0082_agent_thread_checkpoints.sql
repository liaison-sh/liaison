-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_thread_checkpoints (P4m-T05): one agent's rolling summary of one
-- thread, one row per version, immutable once written.
--
-- RLS is 0057's agent_memory policy SHAPE, minus its legacy bridge clause.
-- 0057 rescues rows whose owner_agent_id is NULL, because a user who existed
-- before personal agents shipped has memory rows with no owning agent. NO SUCH
-- ROW CAN EXIST HERE: agent_id is NOT NULL and every checkpoint is written by
-- this slice's own code, so there is nothing for a bridge to rescue. A later
-- pass removing 0057's bridge should not come looking for one in this file.
--
-- The write branch requires '*' or kernel:agents:admin for a role or system
-- agent's checkpoint (A15, 0057's write-branch amendment), and ownership for a
-- personal agent's. The read branch gates a role or system agent's checkpoint
-- on kernel.scopes_cover_ceiling against required_scopes, exactly as 0056 does
-- for memory: a checkpoint carries the union of what the agent read to build
-- it, so a caller holding a strict subset must not see it.
--
-- IMMUTABILITY: a BEFORE UPDATE trigger raises when, and ONLY when, one of
-- summary, upto_message_id, version or required_scopes changes. Every other
-- column stays mutable, and stale_at is DELIBERATELY mutable in both
-- directions: P4m-T23 sets it when a covered message is deleted and P4m-T26
-- clears it when the artefact is rebuilt. A blanket row level immutability
-- trigger would block both, so do not widen this one.
--
-- Every statement is re-runnable, following the 0033/0045/0049/0050
-- convention.

CREATE TABLE IF NOT EXISTS kernel.agent_thread_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES kernel.threads(id) ON DELETE CASCADE,
  upto_message_id uuid,
  summary text NOT NULL,
  required_scopes text[] NOT NULL,
  token_estimate integer NOT NULL,
  version integer NOT NULL,
  stale_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_thread_checkpoints_agent_org_fk'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_thread_checkpoints
      ADD CONSTRAINT agent_thread_checkpoints_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id);
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS agent_thread_checkpoints_agent_thread_version_idx
  ON kernel.agent_thread_checkpoints (agent_id, thread_id, version);
--> statement-breakpoint

ALTER TABLE kernel.agent_thread_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_thread_checkpoints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agent_thread_checkpoints TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_select ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_select ON kernel.agent_thread_checkpoints FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND (
      EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_thread_checkpoints.agent_id
          AND a.kind = 'personal'
          AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          AND a.archived_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM kernel.agents a
        WHERE a.id = kernel.agent_thread_checkpoints.agent_id
          AND a.kind IN ('role', 'system')
          AND kernel.scopes_cover_ceiling(
            string_to_array(current_setting('app.current_scopes', true), ','),
            to_jsonb(kernel.agent_thread_checkpoints.required_scopes)
          )
      )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_insert ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_insert ON kernel.agent_thread_checkpoints FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_update ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_update ON kernel.agent_thread_checkpoints FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS agent_thread_checkpoints_delete ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE POLICY agent_thread_checkpoints_delete ON kernel.agent_thread_checkpoints FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.id = kernel.agent_thread_checkpoints.agent_id
        AND (
          (
            a.kind = 'personal'
            AND a.owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
          )
          OR (
            a.kind IN ('role', 'system')
            AND (
              '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
              OR 'kernel:agents:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
            )
          )
        )
    )
  );
--> statement-breakpoint

-- A version row is immutable once written. The carve out is deliberate and
-- must not be widened: stale_at moves in both directions over the life of a
-- row (set when a covered message is deleted, cleared when the artefact is
-- rebuilt), so only the four columns that DEFINE the version are guarded.
CREATE OR REPLACE FUNCTION kernel.agent_thread_checkpoint_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.upto_message_id IS DISTINCT FROM OLD.upto_message_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.required_scopes IS DISTINCT FROM OLD.required_scopes THEN
    RAISE EXCEPTION 'agent_thread_checkpoints version rows are immutable: write a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_thread_checkpoints_immutable ON kernel.agent_thread_checkpoints;
--> statement-breakpoint
CREATE TRIGGER agent_thread_checkpoints_immutable
  BEFORE UPDATE ON kernel.agent_thread_checkpoints
  FOR EACH ROW EXECUTE FUNCTION kernel.agent_thread_checkpoint_immutable();
