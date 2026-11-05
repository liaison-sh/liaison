-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.agent_knowledge_pointers: the per-agent knowledge-collection pointer
-- table (P1a-T12). One row per (agent_id, collection_id) recording which
-- Knowledge collections an agent has been pointed at.
--
-- collection_id points at app_knowledge.collections.id, but that table has
-- no Drizzle pgTable export to reference (the Knowledge app accesses it via
-- raw SQL through knowledgeRel(), not a schema object), and no precedent
-- exists for a kernel table holding a Drizzle/SQL-level FK into an app_*
-- schema table. So collection_id is a plain uuid with no FK constraint here;
-- referential integrity to app_knowledge.collections is enforced by the
-- app-level write path instead.
--
-- RLS: SELECT-only org match for liaison_rls (agent_knowledge_pointers_select,
-- same shape as agent_skill_index's A13). No INSERT/UPDATE/DELETE policy is
-- created for liaison_rls at all; writes happen exclusively through
-- withPrivilegedDb/the app-level write path, which bypasses RLS via the
-- liaison_admin (BYPASSRLS) connection. The table-level GRANT below follows
-- 0049's convention (SELECT/INSERT/UPDATE/DELETE to liaison_rls, liaison_app)
-- but with no write policy created, FORCE RLS default-denies every
-- INSERT/UPDATE/DELETE attempted as liaison_rls regardless of the grant, so
-- there is no direct write path for that role.
--
-- Every statement here is RE-RUNNABLE, following the convention 0033/0045/
-- 0049 established: a journal `when` raised above an already-deployed
-- highwater can cause this file to run a second time on a database that
-- applied it under an earlier draft.

CREATE TABLE IF NOT EXISTS kernel.agent_knowledge_pointers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kernel.agents(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_pointers_agent_collection_idx
  ON kernel.agent_knowledge_pointers (agent_id, collection_id);
--> statement-breakpoint
ALTER TABLE kernel.agent_knowledge_pointers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_knowledge_pointers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.agent_knowledge_pointers TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS agent_knowledge_pointers_select ON kernel.agent_knowledge_pointers;
CREATE POLICY agent_knowledge_pointers_select ON kernel.agent_knowledge_pointers FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
