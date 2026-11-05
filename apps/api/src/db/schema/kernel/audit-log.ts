// SPDX-License-Identifier: FSL-1.1-ALv2
import { foreignKey, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel } from "./organizations"

export const actorTypeEnum = kernel.enum("actor_type", ["user", "agent", "system", "mcp"])

export const auditLog = kernel.table(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorType: actorTypeEnum("actor_type").notNull(),
    app: text("app"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    action: text("action").notNull(),
    changes: jsonb("changes"),
    metadata: jsonb("metadata"),
    eventId: uuid("event_id"),
    // Agent-turn identity and security context. agentId is the acting agent,
    // set on every agent-turn row whatever the actorType, independent of the
    // human actorId. Agents are archived rather than deleted, so SET NULL only
    // fires on org deletion or on a personal agent's erasure, and never blocks
    // either. All five are null on non-agent rows.
    agentId: uuid("agent_id"),
    requesterUserId: uuid("requester_user_id"),
    roomMemberSnapshot: jsonb("room_member_snapshot").$type<string[]>(),
    effectiveScope: text("effective_scope").array(),
    disclosureList: uuid("disclosure_list").array(),
  },
  (table) => [
    // The agent must belong to the ROW'S OWN ORG (0070). A foreign key on
    // agent_id alone checks existence only, so org A's row could name org B's
    // agent. The migration spells the delete rule as
    // `ON DELETE SET NULL (agent_id)`, which nulls the agent and keeps the row
    // (and its NOT NULL org_id); Drizzle's builder cannot express that column
    // list, so the rule lives in the SQL and this declaration carries the
    // columns only.
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "audit_log_agent_org_fk",
    }),
    index("audit_log_agent_idx")
      .on(table.agentId)
      .where("agent_id IS NOT NULL" as any),
    index("audit_log_org_timestamp_idx").on(table.orgId, table.timestamp),
    index("audit_log_org_entity_idx").on(table.orgId, table.entityType, table.entityId),
    index("audit_log_org_actor_idx").on(table.orgId, table.actorId),
    uniqueIndex("audit_log_event_id_idx")
      .on(table.eventId)
      .where("event_id IS NOT NULL" as any),
  ],
)
