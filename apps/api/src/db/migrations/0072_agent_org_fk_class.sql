-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Close the "agent foreign key forgets the org" class in ONE migration.
--
-- 0070 gave kernel.audit_log.agent_id a COMPOSITE (agent_id, org_id) foreign
-- key so the named agent must belong to the ROW'S OWN ORG. 0071 did the same
-- for kernel.approval_requests. Each time, another table of the same shape
-- surfaced afterwards. This migration enumerates the class and closes ALL of
-- it: every kernel table that carries an org_id AND references kernel.agents
-- now names the agent through a composite key.
--
-- The five remaining tables and why a single-column key was wrong on each:
--
--   routines.owner_agent_id            (0048)  an org-A routine could name an
--     org-B agent. FX23 made a routine tick copy owner_agent_id onto the audit
--     row it emits, where audit_log's own composite guard rejects it with
--     23503; the durable audit handler treats that as fatal, so the outbox
--     retried to MAX_ATTEMPTS and DEAD-LETTERED, losing the audit row and the
--     tick's timeline rows with it. Unreachable from product code today (both
--     insert sites resolve the owner through the org-scoped
--     getOrCreatePersonalAgentId), so this is a latent path, not a live bug,
--     but it is a dead-letter path and it is closed here.
--   skills.owner_agent_id              (0046)  same shape; the skill's owner
--     also keys agent_skill_index, so a cross-org owner propagates.
--   agent_memory.owner_agent_id        (0055)  memory is read back BY OWNING
--     AGENT, so a cross-org owner is a cross-tenant read of stored content.
--   agent_skill_index.agent_id         (0049)  the kernel-maintained index of
--     which agent can reach which skill: a cross-org row grants reach.
--   agent_knowledge_pointers.agent_id  (0050)  same, for knowledge collections.
--
-- kernel.agent_migration_ledger carries previous_owner_agent_id and
-- new_owner_agent_id and is deliberately NOT included: it has no foreign key
-- to agents at all, by design (agent-migration-ledger.ts), because the
-- rollback deletes or restores the very rows it names and a ledger row must
-- outlive them. Adding a key there would break the rollback it exists to serve.
--
-- ON DELETE IS PRESERVED EXACTLY, PER TABLE. It is deliberately NOT harmonised
-- onto 0070/0071's SET NULL, because modules/erasure/erase-user.ts depends on
-- BOTH halves of the current behaviour:
--
--   * routines / skills / agent_memory keep NO ACTION (deleting a referenced
--     agent is refused). Erasure explicitly DELETEs the personal agent's
--     routines and memory rows and NULLs skills.owner_agent_id BEFORE deleting
--     the agent, and its own comments cite this refusal as the reason those
--     statements exist. Turning them into SET NULL would keep erasure working
--     while silently removing the backstop that would catch a future erasure
--     that forgot one, and would let any OTHER agent-delete path leave a
--     routine running with no owner. Note this is NO ACTION, not RESTRICT:
--     NO ACTION is checked at end of statement, which is what lets an
--     organizations cascade delete the agents and the routines together.
--   * agent_skill_index / agent_knowledge_pointers keep CASCADE, and their
--     agent_id is NOT NULL so SET NULL is not even expressible. Erasure
--     deliberately writes no statement for these two and relies on the cascade.
--
-- So account erasure is unaffected by this migration: same refusals, same
-- cascades, same ordering. The only new outcome anywhere is that a CROSS-ORG
-- agent id is now rejected at insert time on all five tables.
--
-- Every key reuses the UNIQUE (id, org_id) on kernel.agents added by 0070
-- (`agents_id_org_uk`); it is NOT re-added. The guard below fails loudly if it
-- is absent rather than silently creating a second one.
--
-- Each key is added NOT VALID and validated in a second step, for 0070's
-- reasons: NOT VALID takes a brief lock and already enforces every new row,
-- and VALIDATE then scans under SHARE UPDATE EXCLUSIVE, which does not block
-- writers. No existing row violates any of the five (verified on the hardening
-- database before this migration was written), so validation rejects nothing.
--
-- Re-runnable: every step is guarded by a catalog lookup.
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

-- 1. kernel.routines.owner_agent_id -- NO ACTION preserved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'routines_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.routines
      ADD CONSTRAINT routines_agent_org_fk
      FOREIGN KEY (owner_agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.routines VALIDATE CONSTRAINT routines_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_owner_agent_id_fkey;
--> statement-breakpoint
-- The dropped single-column key had no supporting index either, but the
-- composite key's delete-time lookup is (owner_agent_id, org_id) and no
-- existing index leads with owner_agent_id, so every agent delete would seq
-- scan kernel.routines. The other four tables already have a usable index
-- (skills_unique_owner_agent_name_idx, agent_memory_org_owner_type_name_idx,
-- agent_skill_index_agent_skill_name_idx,
-- agent_knowledge_pointers_agent_collection_idx).
CREATE INDEX IF NOT EXISTS routines_owner_agent_idx
  ON kernel.routines (owner_agent_id, org_id)
  WHERE owner_agent_id IS NOT NULL;
--> statement-breakpoint

-- 2. kernel.skills.owner_agent_id -- NO ACTION preserved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'skills_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.skills
      ADD CONSTRAINT skills_agent_org_fk
      FOREIGN KEY (owner_agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.skills VALIDATE CONSTRAINT skills_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.skills DROP CONSTRAINT IF EXISTS skills_owner_agent_id_fkey;
--> statement-breakpoint

-- 3. kernel.agent_memory.owner_agent_id -- NO ACTION preserved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_memory_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_memory
      ADD CONSTRAINT agent_memory_agent_org_fk
      FOREIGN KEY (owner_agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.agent_memory VALIDATE CONSTRAINT agent_memory_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.agent_memory DROP CONSTRAINT IF EXISTS agent_memory_owner_agent_id_fkey;
--> statement-breakpoint

-- 4. kernel.agent_skill_index.agent_id -- CASCADE preserved (agent_id is NOT
--    NULL, so SET NULL is not expressible and CASCADE is what erasure relies on).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_skill_index_agent_org_fk' AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_skill_index
      ADD CONSTRAINT agent_skill_index_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.agent_skill_index VALIDATE CONSTRAINT agent_skill_index_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.agent_skill_index DROP CONSTRAINT IF EXISTS agent_skill_index_agent_id_fkey;
--> statement-breakpoint

-- 5. kernel.agent_knowledge_pointers.agent_id -- CASCADE preserved, same reason.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_knowledge_pointers_agent_org_fk'
       AND connamespace = 'kernel'::regnamespace
  ) THEN
    ALTER TABLE kernel.agent_knowledge_pointers
      ADD CONSTRAINT agent_knowledge_pointers_agent_org_fk
      FOREIGN KEY (agent_id, org_id) REFERENCES kernel.agents (id, org_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kernel.agent_knowledge_pointers
  VALIDATE CONSTRAINT agent_knowledge_pointers_agent_org_fk;
--> statement-breakpoint
ALTER TABLE kernel.agent_knowledge_pointers
  DROP CONSTRAINT IF EXISTS agent_knowledge_pointers_agent_id_fkey;
