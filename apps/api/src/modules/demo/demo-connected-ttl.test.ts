// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo visitor workspace that completes a real outside connection lives
// LIAISON_DEMO_CONNECTED_TTL_HOURS from then, not the short visitor TTL it was
// created with: the workspace used to expire under a visitor mid-test, right
// after they connected their own MCP server.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { DemoOrgMarker } from "@liaison/shared"
import { makeMcpRepo } from "~/apps/mcp-manager/repo"
import { buildMcpWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import type { AppEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { buildConnectedAccountCreateEvent } from "~/modules/apps/connections/reconcile-event"
import {
  extendDemoOrgOnConnection,
  handleDemoConnectionEvent,
} from "~/modules/demo/demo-connected-ttl"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  loadDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { HealthTracker } from "~/modules/mcp-client/health"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOUR = 3600_000
const CONNECTED_MS = env.LIAISON_DEMO_CONNECTED_TTL_HOURS * HOUR

/** A visitor marker created 40 minutes ago, expiring in 5 minutes. */
function soonMarker() {
  return {
    ...visitorMarker(1, new Date(Date.now() - 40 * 60_000)),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}

/** The marker's expiry as stored, read past the cache. */
async function storedExpiry(orgId: string): Promise<number | null> {
  invalidateDemoMarker(orgId)
  const raw = (await loadDemoMarker(orgId))?.expiresAt
  return raw ? Date.parse(raw) : null
}

function connectEvent(orgId: string, extra: Record<string, unknown> = {}): AppEvent {
  return {
    app: "kernel",
    entity: "connected_account",
    action: "create",
    entityId: crypto.randomUUID(),
    data: { orgId, appName: "gitlab", providerType: "oauth2", status: "active", ...extra },
    actorId: null,
    actorType: "user",
    orgId,
    timestamp: new Date().toISOString(),
  }
}

let seq = 0
async function visitorOrg(marker: DemoOrgMarker = soonMarker()): Promise<string> {
  seq++
  const { orgId } = await ensureOrg({ slug: `conn-ttl-${seq}-${Date.now()}`, name: "Conn TTL" })
  await markOrgAsDemo(orgId, marker)
  return orgId
}

describe("a demo visitor workspace that connects a real service lives longer", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    DemoModeTestAccess.set(null)
    invalidateDemoMarker()
    await releaseTestLock()
  })
  afterEach(() => {
    DemoModeTestAccess.set(null)
  })

  it("a kernel connection moves a soon-expiring visitor org to now + the connected TTL", async () => {
    DemoModeTestAccess.set(true)
    const orgId = await visitorOrg()
    const before = Date.now()
    await handleDemoConnectionEvent(connectEvent(orgId))
    const after = await storedExpiry(orgId)
    expect(after).not.toBeNull()
    expect(after as number).toBeGreaterThanOrEqual(before + CONNECTED_MS - 1000)
    expect(after as number).toBeLessThanOrEqual(Date.now() + CONNECTED_MS + 1000)
    expect(env.LIAISON_DEMO_CONNECTED_TTL_HOURS).toBe(168)
  })

  it("takes effect at once, past the marker cache", async () => {
    DemoModeTestAccess.set(true)
    const orgId = await visitorOrg()
    // Warm the cache with the short expiry, then extend.
    const cached = Date.parse((await loadDemoMarker(orgId))?.expiresAt ?? "")
    expect(cached).toBeLessThan(Date.now() + HOUR)
    await extendDemoOrgOnConnection(orgId)
    const next = Date.parse((await loadDemoMarker(orgId))?.expiresAt ?? "")
    expect(next).toBeGreaterThan(Date.now() + CONNECTED_MS - 60_000)
  })

  it("an MCP OAuth consent extends", async () => {
    DemoModeTestAccess.set(true)
    const orgId = await visitorOrg()
    await handleDemoConnectionEvent({
      ...connectEvent(orgId),
      app: "mcp_manager",
      entity: "connection",
      action: "oauth_completed",
      data: { slug: "notion", subject: null },
    })
    expect((await storedExpiry(orgId)) as number).toBeGreaterThan(
      Date.now() + CONNECTED_MS - 60_000,
    )
  })

  it("an MCP connection's first successful handshake extends (bearer, headers, any auth)", async () => {
    DemoModeTestAccess.set(true)
    const world = await buildMcpWorld()
    await markOrgAsDemo(world.org.id, soonMarker())
    const connectionId = await withSystemDb("seed-conn", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `ttl-${Math.random().toString(36).slice(2, 8)}`,
          displayName: "TTL",
          transport: "http",
          httpUrl: "https://example.test",
          authFlavor: "bearer",
          managedBy: "ui",
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    await new HealthTracker(makeMcpRepo()).markConnected(connectionId)
    expect((await storedExpiry(world.org.id)) as number).toBeGreaterThan(
      Date.now() + CONNECTED_MS - 60_000,
    )
  })

  it("never touches the reserved org, whose expiry is null on purpose", async () => {
    DemoModeTestAccess.set(true)
    const orgId = await visitorOrg(reservedMarker())
    await handleDemoConnectionEvent(connectEvent(orgId))
    invalidateDemoMarker(orgId)
    const marker = await loadDemoMarker(orgId)
    expect(marker?.variant).toBe("reserved")
    expect(marker?.expiresAt).toBeNull()
  })

  it("a seeded or replayed demo connection does not extend", async () => {
    DemoModeTestAccess.set(true)
    const orgId = await visitorOrg()
    const before = await storedExpiry(orgId)
    // The demo's fixtures write their rows without any event; the only event a
    // fixture row can ever produce is the reconcile replay.
    const replay = buildConnectedAccountCreateEvent(
      {
        id: crypto.randomUUID(),
        appName: "shopify",
        connectionName: "shopify",
        ownerType: "org",
        ownerId: null,
        providerType: "oauth2",
        identifier: "demo.myshopify.com",
      },
      orgId,
      null,
      "",
    )
    await handleDemoConnectionEvent(replay)
    expect(await storedExpiry(orgId)).toBe(before)
  })

  it("does nothing without demo mode", async () => {
    DemoModeTestAccess.set(false)
    const orgId = await visitorOrg()
    const before = await storedExpiry(orgId)
    expect(await extendDemoOrgOnConnection(orgId)).toBeNull()
    await handleDemoConnectionEvent(connectEvent(orgId))
    expect(await storedExpiry(orgId)).toBe(before)
  })

  it("never shortens a later expiry, and a repeat is a no-op", async () => {
    DemoModeTestAccess.set(true)
    const far = new Date(Date.now() + 20 * 24 * HOUR).toISOString()
    const orgId = await visitorOrg({ ...soonMarker(), expiresAt: far })
    expect(await extendDemoOrgOnConnection(orgId)).toBeNull()
    expect(await storedExpiry(orgId)).toBe(Date.parse(far))

    const other = await visitorOrg()
    const first = await extendDemoOrgOnConnection(other)
    expect(first).not.toBeNull()
    // A repeat within the same instant cannot move it back.
    expect(await extendDemoOrgOnConnection(other, new Date(Date.now() - HOUR))).toBeNull()
    expect(await storedExpiry(other)).toBe(Date.parse(first as string))
  })
})
