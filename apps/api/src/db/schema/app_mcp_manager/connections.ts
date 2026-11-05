// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organizations } from "~/db/schema/kernel/organizations"
import { users } from "~/db/schema/kernel/users"

// Schema prefix is applied at runtime so worker-isolated test schemas
// (`w<id>_app_mcp_manager`) are addressed correctly — matches the
// `kernel/organizations.ts` precedent. Without the prefix, Drizzle's runtime
// queries hit the unprefixed schema and fail under the E2E test harness's
// per-worker schema cloning.
const schemaPrefix = process.env.SCHEMA_PREFIX ?? ""
if (schemaPrefix && !/^[a-z0-9_]+$/.test(schemaPrefix)) {
  throw new Error(`Invalid SCHEMA_PREFIX: "${schemaPrefix}" — must match /^[a-z0-9_]+$/`)
}
export const appMcpManager = pgSchema(`${schemaPrefix}app_mcp_manager`)

// Enums are bound to `appMcpManager` (not top-level `pgEnum`) so Drizzle
// emits schema-qualified casts that respect the `${SCHEMA_PREFIX}` applied
// to `appMcpManager` above. With top-level `pgEnum`, value literals were
// cast against the unprefixed enum schema while column types were prefixed —
// causing "operator does not exist: <prefixed>.<enum> = <unprefixed>.<enum>"
// errors under the E2E worker-isolation harness.
// Remote servers only. The table still has the old stdio_command / stdio_args
// columns (always NULL, held so by a CHECK): migration 0153 removed the stdio
// transport, and the columns are dropped once no running build reads them.
export const mcpTransportEnum = appMcpManager.enum("mcp_transport", ["http", "sse"])
export const mcpOwnershipScopeEnum = appMcpManager.enum("mcp_ownership_scope", ["org", "personal"])
export const mcpAuthFlavorEnum = appMcpManager.enum("mcp_auth_flavor", [
  "none",
  "bearer",
  "oauth_dcr",
  "oauth_static",
])
export const mcpAgentVisibilityEnum = appMcpManager.enum("mcp_agent_visibility", [
  "discoverable",
  "hidden",
])
export const mcpDefaultPolicyEnum = appMcpManager.enum("mcp_default_policy", [
  "auto",
  "gate_writes",
  "gate_all",
])
export const mcpManagedByEnum = appMcpManager.enum("mcp_managed_by", ["env", "ui"])

export const mcpConnections = appMcpManager.table(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    transport: mcpTransportEnum("transport").notNull(),
    ownershipScope: mcpOwnershipScopeEnum("ownership_scope").notNull().default("org"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    httpUrl: text("http_url"),
    authFlavor: mcpAuthFlavorEnum("auth_flavor").notNull().default("none"),
    secretsEncrypted: text("secrets_encrypted"),
    oauthMetadata: jsonb("oauth_metadata").$type<Record<string, unknown>>(),
    agentVisibility: mcpAgentVisibilityEnum("agent_visibility").notNull().default("discoverable"),
    exposeViaGateway: boolean("expose_via_gateway").notNull().default(true),
    connectionDefaultPolicy: mcpDefaultPolicyEnum("connection_default_policy")
      .notNull()
      .default("gate_writes"),
    managedBy: mcpManagedByEnum("managed_by").notNull().default("ui"),
    disabled: boolean("disabled").notNull().default(false),
    rateCapPerMinute: integer("rate_cap_per_minute"),
    /** When a person last reviewed its tools (the add flow's tools dialog); null = never. */
    toolsReviewedAt: timestamp("tools_reviewed_at", { withTimezone: true }),
    /**
     * Who may use an ORG server's tools (migration 0198): `everyone` (every active
     * member) or `restricted` to the roles and people in `mcp_connection_access`.
     * Ignored for a personal connection, which only its owner uses.
     */
    accessMode: text("access_mode", { enum: ["everyone", "restricted"] })
      .notNull()
      .default("everyone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [uniqueIndex("uq_mcp_connections_org_slug").on(t.orgId, t.slug)],
)

/**
 * The roles and people who may use a restricted org MCP server (migration 0198).
 * The permission loader turns them into the server's tool namespace `mcp:<slug>`.
 */
export const mcpConnectionAccess = appMcpManager.table(
  "mcp_connection_access",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    principalType: text("principal_type", { enum: ["role", "user"] }).notNull(),
    principalId: uuid("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.principalType, t.principalId] })],
)
