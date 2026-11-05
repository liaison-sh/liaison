// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, foreignKey, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"
import { users } from "./users"

export const scopeRequests = kernel.table(
  "scope_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedByType: text("requested_by_type").notNull(), // 'user' | 'agent'
    /**
     * The agent that asked, when an agent turn filed this. `requestedBy` is
     * the HUMAN whose turn it was and stays the row's identity for RLS; this
     * names the speaker, the same fact `approval_requests.agent_id` carries.
     * Null for a request a person filed by hand. The composite
     * (agent_id, org_id) foreign key lives in the table config below (0109).
     */
    agentId: uuid("agent_id"),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedScopes: text("requested_scopes").array().notNull(),
    grantedScopes: text("granted_scopes").array(),
    reason: text("reason"),
    originatingThreadId: uuid("originating_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    summary: jsonb("summary").$type<{ title: string; lines: string[] }>(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "scope_requests_status_chk",
      sql`${t.status} IN ('pending','approved','denied','expired','cancelled')`,
    ),
    check("scope_requests_type_chk", sql`${t.requestedByType} IN ('user','agent')`),
    index("scope_requests_org_status_idx").on(t.orgId, t.status),
    index("scope_requests_requested_by_idx").on(t.orgId, t.requestedBy),
    index("scope_requests_agent_idx").on(t.orgId, t.agentId),
    // The agent must belong to the ROW'S OWN ORG (0109), as 0071 made it for
    // approval_requests: a key on agent_id alone checks existence only. The
    // migration spells the delete rule `ON DELETE SET NULL (agent_id)`, which
    // Drizzle's builder cannot express, so this declaration carries the columns.
    foreignKey({
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "scope_requests_agent_org_fk",
    }),
  ],
)

export type ScopeRequest = typeof scopeRequests.$inferSelect
export type ScopeRequestInsert = typeof scopeRequests.$inferInsert
