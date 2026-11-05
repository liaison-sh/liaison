// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connect-event builder is the single source of truth shared by the
// reconcile service (in-process), the app-registration startup sweep, and the
// reconcile CLI. It must mirror what `handleOAuthCallback` emits on first
// connect so a replay re-drives an app's `onConnectionEstablished` identically.
import { describe, expect, it } from "bun:test"
import { buildConnectedAccountCreateEvent, type ConnectedAccountRow } from "./reconcile-event"

const row: ConnectedAccountRow = {
  id: "ca-1",
  appName: "shopify",
  connectionName: "shop",
  ownerType: "org",
  ownerId: null,
  providerType: "oauth2",
  identifier: "demo.myshopify.com",
}

describe("buildConnectedAccountCreateEvent", () => {
  it("mirrors the first-connect payload (entity/action/data) + reconcile marker", () => {
    const ev = buildConnectedAccountCreateEvent(row, "org-1", "user-1", "https://x.example.com")
    expect(ev.app).toBe("kernel")
    expect(ev.entity).toBe("connected_account")
    expect(ev.action).toBe("create")
    expect(ev.entityId).toBe("ca-1")
    const data = ev.data as Record<string, unknown>
    expect(data.appName).toBe("shopify")
    expect(data.connectionName).toBe("shop")
    expect(data.identifier).toBe("demo.myshopify.com")
    expect(data.status).toBe("active")
    expect(data.providerType).toBe("oauth2")
    // Apps register upstream webhooks against this origin.
    expect(data.kernelPublicBaseUrl).toBe("https://x.example.com")
    expect(data.reconcile).toBe(true)
  })

  it("attributes to the operator when a userId is given", () => {
    const ev = buildConnectedAccountCreateEvent(row, "org-1", "user-1", "https://x")
    expect(ev.actorId).toBe("user-1")
    expect(ev.actorType).toBe("user")
  })

  it("attributes to the system for an unattended (CLI / startup) run", () => {
    const ev = buildConnectedAccountCreateEvent(row, "org-1", null, "https://x")
    expect(ev.actorId).toBeNull()
    expect(ev.actorType).toBe("system")
  })
})
