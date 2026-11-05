// SPDX-License-Identifier: FSL-1.1-ALv2
import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { appMcpManager, mcpConnections } from "./connections"

// Bound to appMcpManager (see comment in connections.ts).
export const mcpConnectionHealthStatusEnum = appMcpManager.enum("mcp_connection_health_status", [
  "connected",
  "idle",
  "dialing",
  "down",
  "failed",
  "needs_reauth",
])

/**
 * One tool as the server's last `tools/list` answered it (plus the synthetic
 * resource/prompt tools Liaison adds from its capabilities): what the boot path
 * projects from, without dialing the server, and where the read-only hints the
 * connection default policy and the tool rows read come from after a restart.
 */
export interface McpListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export const mcpConnectionHealth = appMcpManager.table("mcp_connection_health", {
  connectionId: uuid("connection_id")
    .primaryKey()
    .references(() => mcpConnections.id, { onDelete: "cascade" }),
  status: mcpConnectionHealthStatusEnum("status").notNull().default("idle"),
  lastHandshakeAt: timestamp("last_handshake_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  serverCapabilities: jsonb("server_capabilities").$type<Record<string, unknown>>(),
  /** The last `tools/list`, written on every dial (migration 0200). Null: never listed. */
  toolList: jsonb("tool_list").$type<McpListedTool[]>(),
  toolListAt: timestamp("tool_list_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
