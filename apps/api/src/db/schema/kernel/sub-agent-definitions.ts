// SPDX-License-Identifier: FSL-1.1-ALv2
import { integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

// Declarative sub-agent role registry. One row per (orgId, agentType).
//
// Apps register their sub-agent roles here at install-time (or via the
// `subagent_create` kernel tool). The `scope_ceiling` is validated against the
// owning app's granted scopes — a role cannot declare a ceiling that exceeds
// what the app itself was granted.
//
// `tool_allowlist` null  → all tools reachable via effective scopes
// `tool_allowlist` array → explicit whitelist (intersected with effective scopes)
//
// `context_profile` is a future-knob (v2 lever). v1 honors only 'standard'.
export const subAgentDefinitions = kernel.table(
  "sub_agent_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    agentType: text("agent_type").notNull(),
    whenToUse: text("when_to_use").notNull(),
    scopeCeiling: text("scope_ceiling").array().notNull().default([]),
    toolAllowlist: text("tool_allowlist").array(),
    toolDenylist: text("tool_denylist").array(),
    skills: text("skills").array().notNull().default([]),
    mcpServers: text("mcp_servers").array().notNull().default([]),
    systemPrompt: text("system_prompt").notNull(),
    defaultMaxSteps: integer("default_max_steps"),
    defaultTimeoutMs: integer("default_timeout_ms"),
    defaultSchemaRetryBudget: integer("default_schema_retry_budget"),
    contextProfile: text("context_profile").notNull().default("standard"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sub_agent_definitions_org_type_idx").on(table.orgId, table.agentType)],
)

export type SubAgentDefinition = typeof subAgentDefinitions.$inferSelect
export type NewSubAgentDefinition = typeof subAgentDefinitions.$inferInsert

export type ContextProfile = "minimal" | "standard" | "full"
