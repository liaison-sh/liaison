// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / S20: an app turned Off for the workspace, or restricted away from the
// viewer, has no nav entry. Its tab types stay registered so a direct route
// still resolves and renders the unavailable notice.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  getAppTabAction,
  getTabType,
  registerActivityBarEntry,
  resetRegistry,
} from "~/framework/app-registry"
import { loadManifestApps, resetBootstrap } from "~/framework/bootstrap"
import { isAppUnavailable, setUnavailableApps } from "~/framework/unavailable-apps"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"

const Icon = () => null

function entry(appId: string, order: number) {
  registerActivityBarEntry({
    id: appId,
    icon: Icon,
    label: appId,
    order,
    appId,
    tabAction: { type: `${appId}:home`, entityId: appId, label: appId },
  })
}

describe("unavailable apps: web nav", () => {
  afterEach(() => {
    setUnavailableApps([])
    resetRegistry()
  })

  it("discriminator: an available app has its nav entry", () => {
    entry("invoicing", 10)
    entry("mail", 20)
    expect(getActivityBarEntries().map((e) => e.appId)).toEqual(["invoicing", "mail"])
  })

  it("an unavailable app has no nav entry and open_app cannot reach it; turning it On restores it", () => {
    entry("invoicing", 10)
    entry("mail", 20)
    setUnavailableApps(["invoicing"])
    expect(isAppUnavailable("invoicing")).toBe(true)
    expect(getActivityBarEntries().map((e) => e.appId)).toEqual(["mail"])
    expect(getAppTabAction("invoicing")).toBeNull()
    setUnavailableApps([])
    expect(getActivityBarEntries().map((e) => e.appId)).toEqual(["invoicing", "mail"])
  })

  it("the manifest feed's unavailableApps feeds the store; an in-tree app's routes stay registered", async () => {
    const mailManifest = {
      name: "mail",
      version: "1.0.0",
      views: {
        tabTypes: { "mail:inbox": { component: "MailInbox", label: "Mail" } },
        activityBar: { icon: "MailIcon", label: "Mail", order: 10 },
      },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ name: "mail", manifest: mailManifest, uiBundleUrl: null }],
              unavailableApps: ["invoicing"],
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    )
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    expect(isAppUnavailable("invoicing")).toBe(true)
    expect(isAppUnavailable("mail")).toBe(false)
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()
    expect(getTabType("mail:inbox")).toBeDefined()

    vi.unstubAllGlobals()
    clearAuth()
  })
})
