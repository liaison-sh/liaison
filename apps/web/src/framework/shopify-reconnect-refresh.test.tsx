// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify settings: "Permissions update required" stayed up after a completed
// Reconnect until the page was refreshed by hand. The Reconnect completes
// outside the panel (provider redirect, the desktop's system browser, the
// phone's authentication session), and the new grant is written by the app's
// connect subscriber AFTER the kernel's own connection event went out, so a
// load at reload time still reads the old grant. The panel now refetches
// `settings_load` on the app's `shopify:connection` event, which the subscriber
// emits once the grant is recorded. Renders the REAL panel against the REAL
// host entity-change bus.

import type { HostServices } from "@liaison/host"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { notifyEntityChange, onEntityChange } from "~/framework/entity-changes"
import { createStaleResource } from "~/primitives/createStaleResource"
import { ShopifyDiagnostics } from "../../../../bundled-apps/shopify/src/ui/settings"

const SHOP = "acme.myshopify.com"

function bundle(missingScopes: string[]) {
  return {
    connection: {
      status: "connected",
      shopDomain: SHOP,
      connectedAt: new Date().toISOString(),
      scopesKnown: true,
      missingScopes,
    },
    mappings: [],
    diagnostics: {
      staffMirrorLastSyncedAt: null,
      backfillStatus: "idle",
      backfillCursor: null,
      webhookDeliveriesProcessed24h: 0,
      webhookDeliveriesFailed24h: 0,
    },
    inventoryAllowlist: [],
    seedAvailable: false,
    seedSuggestions: [],
  }
}

/** What the server answers: the old grant until the subscriber records the new one. */
let recordedMissing: string[] = []
let loads = 0

function installHost(): void {
  const host: Partial<HostServices> = {
    accessToken: () => "t",
    invokeTool: (async (_app: string, tool: string) => {
      if (tool === "settings_load") {
        loads++
        return bundle(recordedMissing)
      }
      return {}
    }) as HostServices["invokeTool"],
    createResource: (<T,>(fetcher: () => T | Promise<T>, opts?: { staleAfterMs?: number }) => {
      const res = createStaleResource<T>(fetcher, opts)
      return [res, { refetch: res.refetch, mutate: res.mutate }]
    }) as HostServices["createResource"],
    onEntityChange: (_callerApp, keys, cb, opts) => onEntityChange(keys, cb as never, opts),
  }
  ;(globalThis as unknown as { __liaisonHost: unknown }).__liaisonHost = host
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME =
    "shopify"
}

describe("Shopify settings: Reconnect clears the permissions banner without a page refresh", () => {
  beforeEach(() => {
    recordedMissing = ["read_all_orders"]
    loads = 0
    installHost()
  })
  afterEach(() => {
    ;(globalThis as unknown as { __liaisonHost?: unknown }).__liaisonHost = undefined
  })

  it("refetches settings_load on shopify:connection and drops the banner", async () => {
    const { container } = render(() => <ShopifyDiagnostics />)
    const banner = () => container.querySelector('[data-testid="shopify-scope-drift-banner"]')
    await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 5000 })
    expect(loads).toBe(1)
    // Managed installation: the scope goes into the app's configuration first.
    expect(banner()?.textContent).toContain("shopify app deploy")

    // The connect subscriber recorded the new grant, then announced it.
    recordedMissing = []
    notifyEntityChange({
      key: "shopify:connection",
      app: "shopify",
      entity: "connection",
      action: "updated",
      data: { shopDomain: SHOP, status: "connected" },
    })

    await waitFor(() => expect(banner()).toBeNull(), { timeout: 5000 })
    expect(loads).toBe(2)
  })
})
