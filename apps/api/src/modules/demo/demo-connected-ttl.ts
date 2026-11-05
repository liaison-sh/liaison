// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A visitor workspace that connects a real outside service lives longer.
//
// A visitor org expires LIAISON_DEMO_VISITOR_TTL_HOURS after it is created
// (demo-expiry.ts). That is right for a visitor clicking through the seeded
// world, and wrong for one who has gone to the trouble of connecting their own
// MCP server or app account: the workspace expired under them mid-test. Once a
// visitor org completes a real connection, its `expiresAt` moves to
// max(current, now + LIAISON_DEMO_CONNECTED_TTL_HOURS).
//
// What counts as a real connection, and where it is seen:
//   - `kernel/connected_account:create`: an OAuth callback that stored a grant,
//     or a credentials connection that was saved (service.ts). A replay of that
//     event (`data.reconcile`, the "Repair connection" path) does not count: it
//     re-drives an existing connection, and the demo's own seeded connections
//     (shopify/, warehouse/, boxtal/, api-connector/) are written straight to
//     the table without any event at all.
//   - `mcp_manager/connection:oauth_completed`: an MCP server's OAuth consent
//     came back (mcp-manager/oauth-routes.ts).
//   - an MCP connection's first successful handshake in this process, whatever
//     its auth (bearer token, custom headers, OAuth): HealthTracker calls
//     `extendDemoOrgOnMcpConnected` when a connection moves to `connected`.
//
// The reserved org (expiresAt null on purpose) and normal orgs are never
// touched, and with demo mode off nothing here runs a query.
import { sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { schemaRef } from "~/db/schema-ref"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoOrg } from "~/modules/demo/demo-org"

const log = rootLogger.child({ module: "demo-connected-ttl" })

/**
 * Extend a visitor demo org's expiry after it completed a real outside
 * connection: `expiresAt` becomes max(current, now + connected TTL). Returns
 * the new expiry when it moved, else null.
 *
 * No-op without demo mode (no query), for a normal org, for the reserved org
 * and when the expiry is already that late (one cached marker read, no write).
 * The write is a conditional jsonb_set that never shortens an expiry, so a
 * repeat or a race is harmless.
 */
export async function extendDemoOrgOnConnection(
  orgId: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!isDemoModeEnabled()) return null
  const { marker } = await loadDemoOrg(orgId)
  if (marker?.variant !== "visitor" || !marker.expiresAt) return null
  const target = new Date(now.getTime() + env.LIAISON_DEMO_CONNECTED_TTL_HOURS * 3600_000)
  const current = Date.parse(marker.expiresAt)
  if (Number.isFinite(current) && current >= target.getTime()) return null

  const targetIso = target.toISOString()
  const k = drizzleSql.raw(schemaRef("kernel"))
  // Guarded in SQL as well as above: the cached marker may be stale, and a
  // later expiry written meanwhile must win. Every writer stores
  // `toISOString()`, so the text comparison orders correctly.
  const rows = await withPrivilegedDb(orgId, "demo-extend-on-connection", async (tx) => {
    const result = await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', to_jsonb(${targetIso}::text), false),
        updated_at = now()
      WHERE id = ${orgId}::uuid
        AND settings->'demo'->>'variant' = 'visitor'
        AND jsonb_typeof(settings->'demo'->'expiresAt') = 'string'
        AND settings->'demo'->>'expiresAt' < ${targetIso}
      RETURNING id
    `)
    return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  })
  // The next read (expiry check, status route) sees the new date at once.
  await invalidateDemoMarker(orgId)
  if (rows.length === 0) return null
  log.info({ orgId, expiresAt: targetIso }, "extended a demo workspace after a real connection")
  return targetIso
}

/**
 * The connection events that extend a visitor org: a kernel connection made
 * (not replayed) and an MCP OAuth consent completed.
 */
export function isRealConnectionEvent(event: AppEvent): boolean {
  if (event.ephemeral || !event.orgId) return false
  if (event.app === "kernel" && event.entity === "connected_account") {
    if (event.action !== "create") return false
    const data = event.data as { reconcile?: unknown } | undefined
    return data?.reconcile !== true
  }
  return (
    event.app === "mcp_manager" &&
    event.entity === "connection" &&
    event.action === "oauth_completed"
  )
}

/** Durable-consumer body: extend on a real connection event, never fail the event. */
export async function handleDemoConnectionEvent(event: AppEvent): Promise<void> {
  if (!isDemoModeEnabled() || !isRealConnectionEvent(event) || !event.orgId) return
  try {
    await extendDemoOrgOnConnection(event.orgId)
  } catch (err) {
    log.warn({ err, orgId: event.orgId }, "could not extend a demo workspace after a connection")
  }
}

/**
 * An MCP connection reached `connected` in this process. Resolves the
 * connection's org (one query, demo mode only) and extends it.
 */
export async function extendDemoOrgOnMcpConnected(connectionId: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  try {
    const [row] = await withSystemDb("demo-mcp-connection-org", (tx) =>
      tx
        .select({ orgId: mcpConnections.orgId })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId))
        .limit(1),
    )
    if (row) await extendDemoOrgOnConnection(row.orgId)
  } catch (err) {
    log.warn({ err, connectionId }, "could not extend a demo workspace after an MCP handshake")
  }
}

export const DEMO_CONNECTION_EXTENSION_CONSUMER = "demo-connection-extension"

/** Wire the event half (event-subscribers.ts, demo mode only). */
export function registerDemoConnectionExtension(): void {
  registerDurableEventConsumer(DEMO_CONNECTION_EXTENSION_CONSUMER, (ctx) =>
    handleDemoConnectionEvent(ctx.event),
  )
}
