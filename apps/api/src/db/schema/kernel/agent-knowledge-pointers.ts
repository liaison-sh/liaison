// SPDX-License-Identifier: FSL-1.1-ALv2
import { foreignKey, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"

// Per-agent knowledge-collection pointer table (P1a-T12). One row per
// (agentId, collectionId) recording which Knowledge collections an agent has
// been pointed at.
//
// `collectionId` points at `app_knowledge.collections.id`
// (`apps/api/src/apps/knowledge/collections.ts`), but that table has no
// Drizzle `pgTable` export to reference: the Knowledge app accesses it via
// raw SQL through `knowledgeRel()` (`apps/api/src/apps/knowledge/
// schema-refs.ts`), not a schema object, and no precedent exists anywhere in
// `db/schema/kernel/` for a kernel table holding a Drizzle-level FK into an
// `app_*` schema table. So `collectionId` is stored as a plain `uuid` with no
// Drizzle/SQL FK constraint; referential integrity to
// `app_knowledge.collections` is enforced by the app-level write path
// instead (the same shape the migration documents).
//
// Same RLS shape as agent_skill_index (T11): SELECT-only to org members, no
// direct INSERT/UPDATE/DELETE grant to liaison_rls.
export const agentKnowledgePointers = kernel.table(
  "agent_knowledge_pointers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The composite (agent_id, org_id) foreign key lives in the table config
    // below (0072); ON DELETE CASCADE is preserved there.
    agentId: uuid("agent_id").notNull(),
    collectionId: uuid("collection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The pointed-at agent must belong to the ROW'S OWN ORG (0072), for the
    // same reason as agent_skill_index: this table grants an agent reach into
    // a knowledge collection. ON DELETE CASCADE is unchanged, and agent_id is
    // NOT NULL so SET NULL is not expressible; erase-user.ts relies on the
    // cascade and writes no statement for this table.
    foreignKey({
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_knowledge_pointers_agent_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_knowledge_pointers_agent_collection_idx").on(t.agentId, t.collectionId),
  ],
)

export type AgentKnowledgePointer = typeof agentKnowledgePointers.$inferSelect
export type NewAgentKnowledgePointer = typeof agentKnowledgePointers.$inferInsert
