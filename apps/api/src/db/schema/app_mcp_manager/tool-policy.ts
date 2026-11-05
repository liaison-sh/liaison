// SPDX-License-Identifier: FSL-1.1-ALv2
import { jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { appMcpManager, mcpConnections } from "./connections"

// Bound to appMcpManager (see comment in connections.ts).
export const mcpDecisionEnum = appMcpManager.enum("mcp_decision", ["auto", "gate", "deny"])

export type McpRoleOverride = {
  roleId: string
  decision: "auto" | "gate" | "deny"
}

export const mcpToolPolicy = appMcpManager.table(
  "mcp_tool_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    overrideDecision: mcpDecisionEnum("override_decision"),
    roleOverrides: jsonb("role_overrides").$type<McpRoleOverride[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_mcp_tool_policy_connection_tool").on(t.connectionId, t.toolName)],
)
