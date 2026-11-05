// SPDX-License-Identifier: FSL-1.1-ALv2
import { foreignKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { skills } from "./skills"

// Kernel-maintained cross-agent skill index (D9). One row per (agentId, skillName)
// pointing at the skill an agent can reach, regardless of who authored the skill.
// Writable only by the skill and knowledge mutation paths via the privileged
// connection (T13); RLS lands in this same migration as SELECT-only for
// liaison_rls, with deliberately no INSERT/UPDATE/DELETE policy (A13).
export const agentSkillIndex = kernel.table(
  "agent_skill_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The composite (agent_id, org_id) foreign key lives in the table config
    // below (0072); ON DELETE CASCADE is preserved there.
    agentId: uuid("agent_id").notNull(),
    skillName: text("skill_name").notNull(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The indexed agent must belong to the ROW'S OWN ORG (0072): this table is
    // what says which agent can REACH which skill, so a cross-org row granted
    // reach across a tenant boundary. ON DELETE CASCADE is unchanged, and
    // agent_id is NOT NULL so SET NULL is not expressible here anyway;
    // erase-user.ts deliberately writes no statement for this table and
    // relies on the cascade.
    foreignKey({
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_skill_index_agent_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_skill_index_agent_skill_name_idx").on(t.agentId, t.skillName),
  ],
)

export type AgentSkillIndex = typeof agentSkillIndex.$inferSelect
export type NewAgentSkillIndex = typeof agentSkillIndex.$inferInsert
