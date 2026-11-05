-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P3-T02: kernel.mcp_connections carries an optional agent binding.
-- Journal high-water when this file was written: 1900000056000
-- (0072_agent_org_fk_class); this migration takes 1900000057000.
--
-- agent_id is NULLABLE: absent means a legacy user-scoped connection, whose
-- behaviour is unchanged everywhere. When present, the connection's minted
-- token is narrowed to the agent's ceiling and re-derived on every request.
--
-- The foreign key is COMPOSITE (agent_id, org_id) -> kernel.agents (id, org_id),
-- per the class 0072 closed: mcp_connections carries an org_id, so a
-- single-column key would let an org-A connection name an org-B agent and
-- mint tokens narrowed by a foreign tenant's ceiling. It reuses the shared
-- agents_id_org_uk unique key and is NOT re-added here.
--
-- ON DELETE CASCADE: a hard-deleted agent takes its bound connections with it.
-- Agents are archived rather than deleted in normal operation (an archived
-- agent is refused at bind, at mint and per request in the service layer), so
-- this fires only on org deletion (where mcp_connections cascades anyway) and
-- on a personal agent's erasure, neither of which may be blocked by a leftover
-- connection row.
--
-- mint_scope_snapshot records the intersected scope set at mint time for AUDIT
-- only (A10). It is never read back to authorize a request.
--
-- Re-runnable: IF NOT EXISTS throughout, the key guarded by a catalog lookup.
ALTER TABLE kernel.mcp_connections
  ADD COLUMN IF NOT EXISTS agent_id uuid;
--> statement-breakpoint
ALTER TABLE kernel.mcp_connections
  ADD COLUMN IF NOT EXISTS mint_scope_snapshot text[];
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_connections_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.mcp_connections
      ADD CONSTRAINT mcp_connections_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connections_agent_idx"
  ON "kernel"."mcp_connections" USING btree ("agent_id")
  WHERE agent_id IS NOT NULL;
