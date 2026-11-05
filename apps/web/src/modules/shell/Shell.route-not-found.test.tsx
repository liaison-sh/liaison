// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's answer to an address no registered page owns.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tier = vi.hoisted(() => ({ current: "desktop" as "phone" | "tablet" | "desktop" }))

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    userFromToken: () => ({
      userId: "u1",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

import { registerTabType, resetRegistry, setManifestAppsSettled } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { resetAppIndex } from "~/framework/define-app"
import { clearAuth } from "~/modules/auth/auth-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetDockStore } from "~/modules/shell/dock-store"
import { Shell } from "~/modules/shell/Shell"
import {
  DESKTOP_QUERY,
  PHONE_QUERY,
  type ShellTier,
  syncShellTier,
  TABLET_QUERY,
} from "~/modules/shell/shell-tier"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"

function setTier(next: ShellTier) {
  tier.current = next
  const answer = next === "phone" ? PHONE_QUERY : next === "tablet" ? TABLET_QUERY : DESKTOP_QUERY
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === answer,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  syncShellTier()
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(typeof input === "object" && "url" in input ? input.url : input)
  // The attention feed reads `{ items, errors }`; anything else is a list.
  if (url.includes("attention")) return jsonResponse({ data: { items: [], errors: [] } })
  return jsonResponse({ data: [] })
}) as unknown as typeof fetch

function renderShell() {
  return render(() => (
    <Router>
      <Route path="*" component={Shell} />
    </Router>
  ))
}

async function openTicketsTab() {
  registerTabType("tickets:ticket", {
    component: () => <div data-testid="ticket-body" />,
    sidebar: null,
    icon: () => null,
    urlPattern: "/tickets/:entityId",
    defaultLabel: "Ticket",
    localType: "tickets:ticket",
  })
  openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })
  await waitFor(() => expect(tabStore.activeTabId).toBe("tickets:ticket:t-1"))
}

// L4 of a gestalt walk: `/ads/campaigns` with the Ads app not installed kept the
// previously active tab on screen under the new address. Once every app has
// registered, an address no page answers says so.
describe("an address no page answers", () => {
  beforeEach(() => {
    resetDockStore()
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    bootstrapKernelApps()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    setTier("desktop")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDockStore()
    clearAuth()
    setManifestAppsSettled(false)
  })

  it("says nothing lives there once the manifests settled, and clears on Go to Home", async () => {
    await openTicketsTab()
    window.history.pushState({}, "", "/not-an-app/campaigns")
    renderShell()
    // While apps may still be registering, the address is held, not judged.
    await waitFor(() => expect(window.location.pathname).toBe("/not-an-app/campaigns"))
    expect(screen.queryByTestId("route-not-found")).toBeNull()

    setManifestAppsSettled(true)
    await waitFor(() => expect(screen.getByTestId("route-not-found")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("route-not-found-home"))
    await waitFor(() => expect(screen.queryByTestId("route-not-found")).toBeNull())
  })

  it("a page that owns the address shows no notice", async () => {
    setManifestAppsSettled(true)
    await openTicketsTab()
    window.history.pushState({}, "", "/tickets/t-1")
    renderShell()
    await waitFor(() => expect(tabStore.activeTabId).toBe("tickets:ticket:t-1"))
    expect(screen.queryByTestId("route-not-found")).toBeNull()
  })
})
