// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / S20: an admin turning an app On or Off, removing it or changing who may
// use it reaches every OPEN session at once. The server broadcasts
// `kernel/org_app` ({app, status, accessMode}); the kernel ws handler resyncs
// the manifest feed, whose `unavailableApps` the nav reads, so a desktop app
// that stays up for days drops (or restores) the app without a reload.
import { waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchWsEventMessage, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, loadManifestApps, resetBootstrap } from "~/framework/bootstrap"
import { isAppUnavailable, setUnavailableApps } from "~/framework/unavailable-apps"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"

const ctx = { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false }

let unavailable: string[] = []

function orgAppEvent(app: string, status: string) {
  dispatchWsEventMessage(
    {
      type: "event",
      payload: {
        app: "kernel",
        entity: "org_app",
        action: "update",
        actorId: "admin-1",
        data: { app, status, accessMode: "everyone" },
      },
    },
    ctx,
  )
}

describe("org_app ws event", () => {
  beforeEach(async () => {
    unavailable = []
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [], unavailableApps: unavailable }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    setTokens("fake-token")
    await loadManifestApps()
  })
  afterEach(() => {
    setUnavailableApps([])
    vi.unstubAllGlobals()
    clearAuth()
  })

  it("an app turned Off becomes unavailable in an open session", async () => {
    expect(isAppUnavailable("invoicing")).toBe(false)
    unavailable = ["invoicing"]
    orgAppEvent("invoicing", "disabled")
    await waitFor(() => expect(isAppUnavailable("invoicing")).toBe(true))
  })

  it("turning it back On restores it", async () => {
    unavailable = ["invoicing"]
    orgAppEvent("invoicing", "disabled")
    await waitFor(() => expect(isAppUnavailable("invoicing")).toBe(true))
    unavailable = []
    orgAppEvent("invoicing", "active")
    await waitFor(() => expect(isAppUnavailable("invoicing")).toBe(false))
  })
})
