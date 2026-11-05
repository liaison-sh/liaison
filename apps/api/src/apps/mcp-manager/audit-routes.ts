// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Read endpoints for the audit + usage dashboards on the manager UI.
//
// `audit` query reads from `kernel.audit_log` (NOT `kernel.events` — that
// table does not exist; outbox lives in `kernel.pending_events`, audit history
// in `audit_log`). The orchestrator (Task 17) publishes events with
// `app="mcp"` + `entity="call"` + `action="execute"`; the kernel audit
// subscriber writes them into `audit_log` with `entity_type="call"` and
// `app="mcp"`. The connection id is inside `changes.connection_id`.
//
// `usage` query rolls up the same source by minute for the last `window`.
import { and, desc, eq, gte, lte, sql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { type UserContext, withRlsContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { auditLog } from "~/db/schema/kernel/audit-log"
import { requireScope } from "~/middleware/require-scope"

const MAX_AUDIT_ROWS = 10_000
const DEFAULT_PAGE_SIZE = 50

function actorFromCtx(c: Context<AppEnv>): UserContext {
  return {
    actorType: "user",
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
  }
}

function parseWindowMs(input: string | undefined): number {
  if (!input) return 24 * 60 * 60 * 1000
  const match = /^(\d+)(m|h|d)$/.exec(input)
  if (!match) return 24 * 60 * 60 * 1000
  const n = Number.parseInt(match[1], 10)
  const unit = match[2]
  if (unit === "m") return n * 60 * 1000
  if (unit === "h") return n * 60 * 60 * 1000
  return n * 24 * 60 * 60 * 1000
}

export const mcpManagerAuditRoutes = new Hono<AppEnv>()
  .get("/connections/:id/audit", requireScope("mcp_manager:audit:read"), async (c) => {
    const connectionId = c.req.param("id")
    const actor = actorFromCtx(c)
    const fromParam = c.req.query("from")
    const toParam = c.req.query("to")
    const decisionParam = c.req.query("decision")
    const limitParam = c.req.query("limit")
    const limit = Math.min(
      Number.parseInt(limitParam ?? `${DEFAULT_PAGE_SIZE}`, 10) || DEFAULT_PAGE_SIZE,
      MAX_AUDIT_ROWS,
    )

    // Verify the connection is visible to the actor before exposing audit rows.
    const visible = await withRlsContext(actor, (db) =>
      db
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId)),
    )
    if (visible.length === 0) throw new HTTPException(404, { message: "Connection not found" })

    const conds = [
      eq(auditLog.orgId, actor.orgId),
      eq(auditLog.app, "mcp"),
      sql`${auditLog.changes}->>'connection_id' = ${connectionId}`,
    ]
    if (fromParam) conds.push(gte(auditLog.timestamp, new Date(fromParam)))
    if (toParam) conds.push(lte(auditLog.timestamp, new Date(toParam)))
    if (decisionParam) conds.push(sql`${auditLog.changes}->>'decision' = ${decisionParam}`)

    const rows = await withRlsContext(actor, (db) =>
      db
        .select()
        .from(auditLog)
        .where(and(...conds))
        .orderBy(desc(auditLog.timestamp))
        .limit(limit + 1),
    )
    const truncated = rows.length > limit
    const out = truncated ? rows.slice(0, limit) : rows
    return c.json({ data: out, truncated })
  })
  .get("/connections/:id/usage", requireScope("mcp_manager:usage:read"), async (c) => {
    const connectionId = c.req.param("id")
    const actor = actorFromCtx(c)
    const windowMs = parseWindowMs(c.req.query("window"))
    const since = new Date(Date.now() - windowMs)

    // Verify visibility first.
    const visible = await withRlsContext(actor, (db) =>
      db
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId)),
    )
    if (visible.length === 0) throw new HTTPException(404, { message: "Connection not found" })

    // Aggregate by outcome and tool name. Postgres latency_ms / bytes
    // counters live in `changes->>'latency_ms'` etc.
    const rows = await withRlsContext(actor, (db) =>
      db
        .select({
          outcome: sql<string>`${auditLog.changes}->>'outcome'`,
          toolName: sql<string>`${auditLog.changes}->>'tool_name'`,
          latencyMs: sql<number>`(${auditLog.changes}->>'latency_ms')::int`,
          requestBytes: sql<number>`coalesce((${auditLog.changes}->>'request_bytes')::int, 0)`,
          responseBytes: sql<number>`coalesce((${auditLog.changes}->>'response_bytes')::int, 0)`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, actor.orgId),
            eq(auditLog.app, "mcp"),
            sql`${auditLog.changes}->>'connection_id' = ${connectionId}`,
            gte(auditLog.timestamp, since),
          ),
        ),
    )

    const calls = rows.length
    const errors = rows.filter((r) => r.outcome && r.outcome !== "ok").length
    const latencies = rows.map((r) => r.latencyMs).filter((n) => Number.isFinite(n))
    latencies.sort((a, b) => a - b)
    const p95LatencyMs =
      latencies.length === 0
        ? 0
        : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
    const bytesIn = rows.reduce((acc, r) => acc + (r.requestBytes ?? 0), 0)
    const bytesOut = rows.reduce((acc, r) => acc + (r.responseBytes ?? 0), 0)

    const byTool = new Map<string, number>()
    for (const r of rows) {
      if (!r.toolName) continue
      byTool.set(r.toolName, (byTool.get(r.toolName) ?? 0) + 1)
    }
    const topTools = Array.from(byTool.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([toolName, calls]) => ({ toolName, calls }))

    return c.json({
      data: { calls, errors, p95LatencyMs, bytesIn, bytesOut, topTools, windowMs },
    })
  })
