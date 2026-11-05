// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The native keyboard lifts the whole shell, once. Inside the iOS app the web
// view keeps its full height under the keyboard, so the shell's own height
// stops at the keyboard's top (every route inside it follows), the bottom safe
// area is left to the keyboard that covers it, and the phone tab bar folds
// away instead of sitting between the composer and the keys.
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

import { resetRegistry } from "~/framework/app-registry"
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
import { resetTabStore } from "~/modules/shell/tab-store"
import { applyKeyboardInset } from "~/primitives/keyboardInset"

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

describe("the shell under the native keyboard", () => {
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
    applyKeyboardInset(0)
    vi.restoreAllMocks()
    resetDockStore()
    clearAuth()
    setTier("desktop")
  })

  it("stops at the top of the keyboard rather than at the bottom of the screen", () => {
    setTier("phone")
    const { container } = renderShell()
    const shell = container.querySelector<HTMLElement>("[data-shell]")
    expect(shell?.style.height).toContain("var(--keyboard-inset")
    expect(shell?.style.paddingBottom).toContain("var(--keyboard-inset")
    // A class height would win nothing over the style, but it said 100dvh
    // and nothing else: the reason the composer sat under the keyboard.
    expect(shell?.className).not.toContain("h-dvh")
  })

  it("folds the phone tab bar while the keyboard is up, and brings it back", async () => {
    setTier("phone")
    const { container } = renderShell()
    const shell = container.querySelector<HTMLElement>("[data-shell]")
    const bar = () => container.querySelector<HTMLElement>('[data-testid="phone-tab-bar"]')
    expect(bar()?.style.display).not.toBe("none")
    expect(shell?.style.gridTemplateRows).toBe("minmax(0, 1fr) 56px")

    applyKeyboardInset(336)
    await waitFor(() => expect(bar()?.style.display).toBe("none"))
    expect(shell?.style.gridTemplateRows).toBe("minmax(0, 1fr) 0px")
    expect(shell?.style.getPropertyValue("--shell-bottom-bar")).toBe("0px")

    applyKeyboardInset(0)
    await waitFor(() => expect(bar()?.style.display).not.toBe("none"))
    expect(shell?.style.gridTemplateRows).toBe("minmax(0, 1fr) 56px")
  })
})
