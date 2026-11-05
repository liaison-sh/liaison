// SPDX-License-Identifier: FSL-1.1-ALv2
import { foreignKey, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

// Dynamically Registered OAuth clients (RFC 7591). Public PKCE clients — no secret stored.
export const mcpOauthClients = kernel.table(
  "mcp_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull().unique(),
    clientName: text("client_name"),
    redirectUris: text("redirect_uris").array().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_oauth_clients_client_id_idx").on(table.clientId)],
)

// Durable per-client credential. NOT subject to the login session cap (explicit
// divergence from `sessions`): no eviction, no cap. Owner delete cascades.
export const mcpConnections = kernel.table(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    label: text("label").notNull(),
    // SHA-256 of the high-entropy refresh secret (the hashed long-lived
    // credential material, spec C2). The raw secret is returned once at
    // connection create as `<connId>.<secret>` and never persisted.
    refreshTokenHash: text("refresh_token_hash").notNull(),
    threadId: uuid("thread_id"), // lazily set on first gated call (C8)
    // Deferred tools discovered via liaison_tool_search for THIS connection
    // (spec C4 / criterion 3). Persisted so a fresh stateless reconnect's
    // tools/list still includes the discovered deferred tools.
    discoveredTools: text("discovered_tools").array().notNull().default([]),
    // Skills whose BODY has already been pushed to this connection via an
    // app-anchored tool result. An MCP client has no per-turn system prompt, so
    // the only channel that can carry a playbook to it mid-session is a tool
    // result; this set makes that push exactly-once per skill per connection
    // instead of re-paying the body on every call.
    surfacedSkills: text("surfaced_skills").array().notNull().default([]),
    // Nullable: absent = legacy user-scoped connection, whose behaviour is
    // unchanged. Present = the connection acts AS this agent, so its token is
    // narrowed to the agent's ceiling and re-derived on every request. The
    // composite (agent_id, org_id) foreign key lives in the table config below
    // (0073), so the agent must belong to the connection's own org.
    agentId: uuid("agent_id"),
    // The intersected scope set recorded at mint time, for AUDIT only (A10).
    // Never read back to authorize a request: authorization always recomputes
    // from the grantor's live grants and the agent's live ceiling.
    mintScopeSnapshot: text("mint_scope_snapshot").array(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }), // nullable: "never"
    revokedAt: timestamp("revoked_at", { withTimezone: true }), // nullable: active
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The bound agent must belong to the ROW'S OWN ORG (0073), the class 0072
    // closed: a single-column key checks existence only, so an org-A
    // connection could name an org-B agent and mint tokens narrowed by a
    // foreign tenant's ceiling. ON DELETE CASCADE: a hard-deleted agent takes
    // its bound connections with it.
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "mcp_connections_agent_org_fk",
    }).onDelete("cascade"),
    index("mcp_connections_agent_idx")
      .on(table.agentId)
      .where("agent_id IS NOT NULL" as any),
    index("mcp_connections_user_idx").on(table.userId),
    index("mcp_connections_org_idx").on(table.orgId),
  ],
)
