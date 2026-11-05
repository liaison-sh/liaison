-- SPDX-License-Identifier: FSL-1.1-ALv2
-- X11: kernel.agent_runs records the agent the spawning turn acted as.
-- Journal high-water when this file was written: 1900000057000
-- (0073_mcp_connections_agent_binding); this migration takes 1900000058000.
--
-- A sub-run's TERMINAL event is emitted after the run's own transaction has
-- committed, outside every run frame, so nothing in scope there knows which
-- agent the work belonged to. The identity has to live on the ROW. `spawnAgent`
-- already holds it (the captured parent frame), so it is written at spawn and
-- read back at the terminal emit.
--
-- agent_id is NULLABLE, and null is a positive assertion: NO agent spawned this
-- run (a cron, a job, a webhook), never "we lost track of which one".
--
-- The foreign key is COMPOSITE (agent_id, org_id) -> kernel.agents (id, org_id),
-- per the class 0072 closed: agent_runs carries an org_id, so a single-column
-- key would let an org-A run name an org-B agent, and the audit row the run
-- then emits copies that id onto itself where audit_log's own composite guard
-- rejects it. It reuses the shared agents_id_org_uk unique key.
--
-- ON DELETE SET NULL, unlike 0073's CASCADE: a hard-deleted agent (personal
-- agent erasure) must cost the NAME on a finished run, never the run row and
-- the history hanging off it.
--
-- Re-runnable: IF NOT EXISTS throughout, the key guarded by a catalog lookup.
ALTER TABLE kernel.agent_runs
  ADD COLUMN IF NOT EXISTS agent_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_runs_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_runs
      ADD CONSTRAINT agent_runs_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_agent_idx"
  ON "kernel"."agent_runs" USING btree ("agent_id")
  WHERE agent_id IS NOT NULL;
