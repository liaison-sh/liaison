// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card 117: a deep link to /shopify on the phone painted Home while the URL
// stayed /shopify, and /boxtal opened fine. This is the router-level guard for
// the whole class: at phone tier, EVERY installed app's bare route opens that
// app's own default tab, whether its manifest registered before the shell
// mounted (a warm bundle) or after it (the normal cold load, where the first
// URL to tab pass resolves nothing and the registry version bump is what has
// to re-run it).
//
// It is driven off the REAL bundled manifests rather than a fixture, so an app
// whose default page happens to own the bare pattern (shopify: `/shopify`) and
// one that names a deeper default page (boxtal: `/boxtal/queue/worklist`) are both
// covered, which is the exact pair that behaved differently.
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

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest, resetAppIndex } from "~/framework/define-app"
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

const BUNDLED = resolvePath(__dirname, "../../../../../bundled-apps")

/** Every component a manifest names resolves to an inert stub. */
const stubExports = new Proxy({} as Record<string, unknown>, {
  get: () => () => null,
  has: () => true,
})

function installApp(app: string): void {
  const manifest = JSON.parse(readFileSync(resolvePath(BUNDLED, app, "app.manifest.json"), "utf8"))
  registerAppFromManifest(manifest as never, stubExports as never)
}

/** The tab an app's own navigation (the Work row, the activity bar) opens. */
function workRowTabType(app: string): string {
  const manifest = JSON.parse(readFileSync(resolvePath(BUNDLED, app, "app.manifest.json"), "utf8"))
  const action = manifest.views.activityBar.tabAction
  const local = manifest.views.tabTypes[action.type] ? action.type : action.entityId
  return `${app}:${local}`
}

describe("a phone deep link into an installed app", () => {
  beforeEach(() => {
    resetDockStore()
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    bootstrapKernelApps()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    setTier("phone")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDockStore()
    clearAuth()
    setTier("desktop")
  })

  for (const app of ["shopify", "boxtal", "ads", "monitoring"]) {
    it(`opens ${app} from its bare route when the app is already registered`, async () => {
      installApp(app)
      window.history.pushState({}, "", `/${app}`)
      renderShell()
      await waitFor(() => expect(tabStore.tabs.map((t) => t.type)).toContain(workRowTabType(app)))
      // ...and it is the tab the user is looking at, not a background one.
      expect(tabStore.activeTabId?.startsWith(`${workRowTabType(app)}:`)).toBe(true)
    })

    it(`opens ${app} when its manifest registers AFTER the shell mounted`, async () => {
      window.history.pushState({}, "", `/${app}`)
      renderShell()
      // Nothing owns the path yet: the shell holds Home and keeps the URL.
      await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
      expect(window.location.pathname).toBe(`/${app}`)

      installApp(app)

      await waitFor(() =>
        expect(tabStore.activeTabId?.startsWith(`${workRowTabType(app)}:`)).toBe(true),
      )
    })
  }
})
