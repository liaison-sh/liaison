// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, inArray as inArrayOp, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import {
  mcpConnectionHealth,
  mcpConnections,
  mcpResourceSubscription,
  mcpToolPolicy,
} from "~/db/schema/app_mcp_manager"
import { userRoles } from "~/db/schema/kernel"
import { connectionDefaultDecision } from "./default-policy"
import type {
  ConnectionRow,
  HealthRow,
  McpListedTool,
  McpRepo,
  McpToolAnnotations,
  PerCallDecision,
  PolicyActor,
  SubscriptionRow,
} from "./types"

/**
 * Sentinel toolName used to store connection-wide role overrides on
 * `mcp_tool_policy`. Editing this row from the Policy tab's "Role overrides"
 * subsection grants a role auto/gate/deny treatment across every tool exposed
 * by the connection (review I15). The same column carries per-tool role
 * overrides under the tool's real name, and `getPolicyForCall` consults the
 * per-tool row first, falling back to the connection-wide row.
 */
export const CONNECTION_WIDE_TOOL_NAME = "*"

// In-memory annotation cache keyed by `${connectionId}\n${toolName}` ->
// annotations, filled by every dial's `tools/list` and by the boot projection.
// The list itself is persisted (`mcp_connection_health.tool_list`), so a process
// that has not seen a connection's list yet (a restart, a peer node) reads it
// from there once instead of treating every tool as a write.
const annotationCache = new Map<string, McpToolAnnotations>()
/** Connections whose persisted list this process has already read into the cache. */
const hydratedConnections = new Set<string>()

async function hydrateAnnotations(connectionId: string): Promise<void> {
  if (hydratedConnections.has(connectionId)) return
  const [row] = await withSystemDb("mcp-tool-list-read", (db) =>
    db
      .select({ toolList: mcpConnectionHealth.toolList })
      .from(mcpConnectionHealth)
      .where(eq(mcpConnectionHealth.connectionId, connectionId)),
  )
  hydratedConnections.add(connectionId)
  for (const t of row?.toolList ?? []) {
    const k = annKey(connectionId, t.name)
    if (!annotationCache.has(k)) annotationCache.set(k, t.annotations ?? {})
  }
}

function annKey(connectionId: string, toolName: string): string {
  return `${connectionId}\n${toolName}`
}

function permissiveMax(decisions: PerCallDecision[]): PerCallDecision {
  // auto > gate > deny (lower index = more permissive)
  if (decisions.includes("auto")) return "auto"
  if (decisions.includes("gate")) return "gate"
  return "deny"
}

async function resolveActorRoleIds(actor: PolicyActor): Promise<string[]> {
  if (actor.roleIds && actor.roleIds.length > 0) return actor.roleIds
  return withSystemDb("mcp-repo-resolve-roles", async (db) => {
    const rows = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, actor.userId), eq(userRoles.orgId, actor.orgId)))
    return rows.map((r) => r.roleId)
  })
}

export function makeMcpRepo(): McpRepo {
  return {
    async listForOrgBootstrap(orgId: string): Promise<ConnectionRow[]> {
      return withSystemDb("mcp-bootstrap-list", (db) =>
        db
          .select()
          .from(mcpConnections)
          .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.disabled, false))),
      )
    },

    async getConnectionForCall(connectionId, actor: UserContext) {
      const rows = await withRlsContext(actor, (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId)),
      )
      return rows[0] ?? null
    },

    async getConnectionForCallPrivileged(connectionId) {
      return withSystemDb("mcp-dial-load-connection", async (db) => {
        const rows = await db
          .select()
          .from(mcpConnections)
          .where(eq(mcpConnections.id, connectionId))
        return rows[0] ?? null
      })
    },

    async recordHealth(connectionId, health, opts) {
      return withSystemDb("mcp-health-write", async (db) => {
        // Strip connectionId from setFields explicitly — a future caller that
        // happens to include `connectionId` in `health` would otherwise be
        // able to mutate the PK via the upsert SET clause (review I21).
        const widened: Partial<HealthRow> = health ?? {}
        const { connectionId: _drop, ...healthClean } = widened
        const setFields = { ...healthClean, updatedAt: new Date() }
        const insertFields: typeof mcpConnectionHealth.$inferInsert = { connectionId, ...setFields }
        const keep = opts?.keepNeedsReauth === true
        const rows = await db
          .insert(mcpConnectionHealth)
          .values(insertFields)
          .onConflictDoUpdate({
            target: mcpConnectionHealth.connectionId,
            set: {
              ...setFields,
              ...(keep && setFields.status !== undefined
                ? {
                    status: sql`CASE WHEN ${mcpConnectionHealth.status} = 'needs_reauth' THEN ${mcpConnectionHealth.status} ELSE excluded.status END`,
                    lastError: sql`CASE WHEN ${mcpConnectionHealth.status} = 'needs_reauth' THEN ${mcpConnectionHealth.lastError} ELSE excluded.last_error END`,
                  }
                : {}),
            },
          })
          .returning({ status: mcpConnectionHealth.status })
        return rows[0]?.status ?? null
      })
    },

    async getPolicyForCall(connectionId, toolName, actor) {
      // Policy table is server-side trusted metadata, not user data. Reading
      // it under actor RLS hides overrides from non-admin actors (the policy
      // table is scoped to `mcp_manager:policy:read`, which most users don't
      // have) — so per-tool and per-role overrides were inert for everyone
      // but admins (review I20). Read privileged here; the security boundary
      // is the parent connection's visibility, which is enforced on the
      // subsequent getConnectionForCall under actor RLS.
      //
      // Fetch BOTH the per-tool row and the connection-wide row (sentinel
      // toolName = "*"). The connection-wide row carries org-level role
      // overrides edited from the Policy tab's "Role overrides" subsection
      // (review I15) — those apply when no per-tool override is in play, so
      // an admin can grant a whole role auto-approval without naming each tool.
      const policyRows = await withSystemDb("mcp-policy-read-privileged", (db) =>
        db
          .select()
          .from(mcpToolPolicy)
          .where(
            and(
              eq(mcpToolPolicy.connectionId, connectionId),
              inArrayOp(mcpToolPolicy.toolName, [toolName, CONNECTION_WIDE_TOOL_NAME]),
            ),
          ),
      )
      const policy = policyRows.find((r) => r.toolName === toolName)
      const connWidePolicy = policyRows.find((r) => r.toolName === CONNECTION_WIDE_TOOL_NAME)

      // (a) role overrides — most-permissive wins among matching roles.
      // Per-tool role overrides take precedence over the connection-wide row
      // so a tool-specific decision (e.g. deny "delete_repo" for support) can
      // tighten the broader role grant.
      const roleOverrides = policy?.roleOverrides?.length
        ? policy.roleOverrides
        : (connWidePolicy?.roleOverrides ?? null)
      if (roleOverrides && roleOverrides.length > 0) {
        const actorRoleIds = new Set(await resolveActorRoleIds(actor))
        const matching = roleOverrides.filter((r) => actorRoleIds.has(r.roleId))
        if (matching.length > 0) {
          const decisions = matching.map((m) => m.decision as PerCallDecision)
          const decision = permissiveMax(decisions)
          // Pick the first override that produced the winning decision —
          // deterministic so tests can assert on policyRoleId.
          const winner = matching.find((m) => m.decision === decision)
          return { decision, policyPath: "role", policyRoleId: winner?.roleId }
        }
      }

      // (b) per-tool override
      if (policy?.overrideDecision != null) {
        return { decision: policy.overrideDecision as PerCallDecision, policyPath: "tool" }
      }

      // (c) connection default
      const conn = await this.getConnectionForCall(connectionId, actor)
      if (!conn) {
        // RLS hid the connection from this actor — deny safely.
        return { decision: "deny", policyPath: "connection_default" }
      }
      // gate_writes runs a tool the server annotates read-only (and not destructive) without
      // approval and gates the rest; see default-policy.ts for the rule and its residual risk.
      if (!annotationCache.has(annKey(connectionId, toolName))) {
        await hydrateAnnotations(connectionId)
      }
      const decision = connectionDefaultDecision(
        conn.connectionDefaultPolicy,
        annotationCache.get(annKey(connectionId, toolName)),
      )
      return { decision, policyPath: "connection_default" }
    },

    async createSubscription(args) {
      return withSystemDb("mcp-subscription-create", async (db) => {
        const [row] = await db
          .insert(mcpResourceSubscription)
          .values({
            connectionId: args.connectionId,
            resourceUri: args.resourceUri,
            subscriberActorId: args.subscriberActorId,
            subscriberActorType: args.subscriberActorType,
            threadId: args.threadId ?? null,
          })
          .returning({ id: mcpResourceSubscription.id })
        return { id: row.id }
      })
    },

    async deleteSubscription(id) {
      await withSystemDb("mcp-subscription-delete", async (db) => {
        await db.delete(mcpResourceSubscription).where(eq(mcpResourceSubscription.id, id))
      })
    },

    async listSubscriptions(connectionId, resourceUri): Promise<SubscriptionRow[]> {
      return withSystemDb("mcp-subscription-list", (db) =>
        db
          .select()
          .from(mcpResourceSubscription)
          .where(
            and(
              eq(mcpResourceSubscription.connectionId, connectionId),
              eq(mcpResourceSubscription.resourceUri, resourceUri),
            ),
          ),
      )
    },

    async upsertToolAnnotations(connectionId, tools) {
      for (const { name, annotations } of tools) {
        annotationCache.set(annKey(connectionId, name), annotations)
      }
    },

    getToolAnnotations(connectionId, toolName) {
      return annotationCache.get(annKey(connectionId, toolName))
    },

    async saveToolList(connectionId, tools) {
      const listed: McpListedTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        annotations: t.annotations ?? {},
      }))
      await this.upsertToolAnnotations(
        connectionId,
        listed.map((t) => ({ name: t.name, annotations: t.annotations })),
      )
      hydratedConnections.add(connectionId)
      const now = new Date()
      await withSystemDb("mcp-tool-list-write", (db) =>
        db
          .insert(mcpConnectionHealth)
          .values({ connectionId, toolList: listed, toolListAt: now })
          .onConflictDoUpdate({
            target: mcpConnectionHealth.connectionId,
            set: { toolList: listed, toolListAt: now },
          }),
      )
    },

    async listToolLists(connectionIds) {
      const out = new Map<string, McpListedTool[]>()
      if (connectionIds.length === 0) return out
      const rows = await withSystemDb("mcp-tool-lists-boot", (db) =>
        db
          .select({
            connectionId: mcpConnectionHealth.connectionId,
            toolList: mcpConnectionHealth.toolList,
          })
          .from(mcpConnectionHealth)
          .where(inArrayOp(mcpConnectionHealth.connectionId, [...connectionIds])),
      )
      for (const r of rows) if (r.toolList) out.set(r.connectionId, r.toolList)
      return out
    },
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const McpManagerRepoTestAccess = {
  /** Test-only: clear the in-memory annotation cache between cases. */
  clearAnnotationCache(): void {
    annotationCache.clear()
    hydratedConnections.clear()
  },
}
