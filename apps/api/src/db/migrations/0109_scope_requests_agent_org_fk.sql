-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.scope_requests.agent_id joins the composite-key class.
--
-- 0098 added scope_requests.agent_id with a SINGLE-column foreign key to
-- kernel.agents, which checks existence only, so org A's scope request could
-- name org B's agent. The standing guard (db/schema/kernel/agent-org-fk.test.ts,
-- "every org-scoped table referencing kernel.agents uses a composite key") has
-- been red since 0098 landed. This is the same fix 0071 made for
-- approval_requests.agent_id, the column 0098 was modelled on.
--
-- ON DELETE SET NULL (agent_id) names the column list (Postgres 15+), so
-- deleting an agent still nulls agent_id and keeps the request, exactly as 0098
-- behaved, and never touches the NOT NULL org_id.
--
-- A row already naming an agent of another org carries a fact that was never
-- true for its org; it is nulled (the value 0098 gives a request filed by hand)
-- before VALIDATE, rather than letting VALIDATE fail the deploy on it.
--
-- NOT VALID then VALIDATE, for 0070's reasons. The UNIQUE (id, org_id) on
-- kernel.agents (`agents_id_org_uk`, 0070) is reused, not re-added. The
-- existing scope_requests_agent_idx (org_id, agent_id) already serves the key's
-- delete-time lookup. Every statement is re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_id_org_uk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    RAISE EXCEPTION 'kernel.agents is missing agents_id_org_uk (migration 0070); apply 0070 first';
  END IF;
END $$;
--> statement-breakpoint
UPDATE kernel.scope_requests sr
   SET agent_id = NULL
 WHERE sr.agent_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM kernel.agents a WHERE a.id = sr.agent_id AND a.org_id = sr.org_id
   );
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scope_requests_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.scope_requests
      ADD CONSTRAINT scope_requests_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE SET NULL (agent_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests VALIDATE CONSTRAINT scope_requests_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests DROP CONSTRAINT IF EXISTS scope_requests_agent_id_fkey;
