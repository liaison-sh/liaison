// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F2. The round Chats opener is the TABLET entry to the Chats sheet. At phone
// tier the Chats seat in the tab bar is that entry, so the floating button was
// a second one, parked over the bottom right corner of whatever screen the
// user was on.
import { Route, Router } from "@solidjs/router"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tier = vi.hoisted(() => ({ current: "phone" as "phone" | "tablet" | "desktop" }))

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

import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
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

describe("the floating Chats opener", () => {
  beforeEach(() => {
    resetDockStore()
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    window.history.pushState({}, "", "/")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDockStore()
    clearAuth()
    setTier("desktop")
  })

  it("is not rendered at phone tier", async () => {
    setTier("phone")
    const { container } = renderShell()
    await openTicketsTab()
    expect(container.querySelector('[data-testid="chats-sheet-opener"]')).toBeNull()
    // The seat that replaces it is right there.
    expect(container.querySelector('[data-testid="phone-tab-chats"]')).not.toBeNull()
  })

  it("is still rendered at tablet tier", async () => {
    setTier("tablet")
    const { container } = renderShell()
    await openTicketsTab()
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chats-sheet-opener"]')).not.toBeNull(),
    )
  })

  // It used to vanish on Home and on a thread tab, on the argument that the
  // conversation was already the screen. The entry to a user's chats does not
  // come and go with the surface they are standing on: the desktop strip is on
  // every surface now, and so is its tablet counterpart.
  it("is rendered on Home at tablet tier", async () => {
    setTier("tablet")
    const { container } = renderShell()
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chats-sheet-opener"]')).not.toBeNull(),
    )
  })

  // The composer's card pads its bottom by --shell-dock-clearance. At tablet
  // it was 0, and the round opener (bottom 16px, 44px tall) sat on the
  // composer's send button.
  it("publishes a composer clearance that clears the opener at tablet, nothing on the phone or desktop", async () => {
    const clearance = (container: HTMLElement) =>
      (container.querySelector("[data-shell]") as HTMLElement).style.getPropertyValue(
        "--shell-dock-clearance",
      )

    setTier("tablet")
    const tablet = renderShell()
    await waitFor(() => expect(clearance(tablet.container)).toBe("64px"))
    tablet.unmount()

    setTier("phone")
    const phone = renderShell()
    await waitFor(() => expect(clearance(phone.container)).toBe("0px"))
    phone.unmount()

    setTier("desktop")
    const desktop = renderShell()
    // The bar is anchored flush to the corner at desktop: nothing reserves a
    // band for it.
    await waitFor(() => expect(clearance(desktop.container)).toBe("0px"))
  })
})
