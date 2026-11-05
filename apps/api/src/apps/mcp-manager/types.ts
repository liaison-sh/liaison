// SPDX-License-Identifier: FSL-1.1-ALv2
import type { UserContext } from "~/db/rls"
import type {
  McpListedTool,
  mcpConnectionHealth,
  mcpConnections,
  mcpResourceSubscription,
} from "~/db/schema/app_mcp_manager"

export type { McpListedTool }

export type ConnectionRow = typeof mcpConnections.$inferSelect
export type SubscriptionRow = typeof mcpResourceSubscription.$inferSelect
export type HealthRow = typeof mcpConnectionHealth.$inferSelect

export type PerCallDecision = "auto" | "gate" | "deny"
export type PolicyPath = "role" | "tool" | "connection_default"

export interface PolicyResolution {
  decision: PerCallDecision
  policyPath: PolicyPath
  /** Populated when `policyPath = "role"`. */
  policyRoleId?: string
}

/** Server-supplied tool annotations cached in-memory after `tools/list`. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * The actor passed to `getPolicyForCall` is widened with `roleIds` — repo-local
 * widening only (the canonical `UserContext` in `~/db/rls` does not carry role
 * ids). Callers populate this from `kernel.user_roles` lookups.
 */
export interface PolicyActor extends UserContext {
  roleIds?: string[]
}

/** Kernel ↔ app boundary (spec §4.1). The kernel imports only this interface. */
export interface McpRepo {
  /** The org's enabled connections (privileged read), projected at its first touch. */
  listForOrgBootstrap(orgId: string): Promise<ConnectionRow[]>
  getConnectionForCall(connectionId: string, actor: UserContext): Promise<ConnectionRow | null>
  /**
   * Privileged read for kernel-side dialing. Used by the connection-pool's
   * `dial` callback at handshake time — the dialer is server-trusted code that
   * must decrypt secrets to connect, and runs outside any user RLS context.
   * Returns null when the connection has been deleted between the call and
   * the dial.
   */
  getConnectionForCallPrivileged(connectionId: string): Promise<ConnectionRow | null>
  /**
   * Upsert the health row; returns the status it holds afterwards. With
   * `keepNeedsReauth`, a row in `needs_reauth` keeps that status and its
   * reason: only a new sign-in (or a credential edit) clears it.
   */
  recordHealth(
    connectionId: string,
    health: Partial<Omit<HealthRow, "connectionId">>,
    opts?: { keepNeedsReauth?: boolean },
  ): Promise<HealthRow["status"] | null>
  getPolicyForCall(
    connectionId: string,
    toolName: string,
    actor: PolicyActor,
  ): Promise<PolicyResolution>
  createSubscription(args: {
    connectionId: string
    resourceUri: string
    subscriberActorId: string
    subscriberActorType: "user" | "agent"
    threadId?: string
  }): Promise<{ id: string }>
  deleteSubscription(id: string): Promise<void>
  listSubscriptions(connectionId: string, resourceUri: string): Promise<SubscriptionRow[]>
  upsertToolAnnotations(
    connectionId: string,
    tools: Array<{ name: string; annotations: McpToolAnnotations }>,
  ): Promise<void>
  /** Read-through cache lookup — undefined when not yet projected. */
  getToolAnnotations(connectionId: string, toolName: string): McpToolAnnotations | undefined
  /**
   * Persist the server's whole `tools/list` (with the synthetic tools projected beside it) and
   * cache its annotations: the boot path projects from it and the per-call decision reads its
   * hints after a restart, before any dial.
   */
  saveToolList(connectionId: string, tools: McpListedTool[]): Promise<void>
  /** The persisted `tools/list` of each given connection that has one. */
  listToolLists(connectionIds: readonly string[]): Promise<Map<string, McpListedTool[]>>
}
